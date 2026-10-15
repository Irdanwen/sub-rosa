//! Windows: the computer's sound through WASAPI loopback, in process
//! (ADR-0112).
//!
//! cpal opens a loopback stream when an input stream is built on an output
//! device. One worker thread owns that stream (so nothing asks whether a
//! WASAPI stream may cross threads), turns what it delivers into the lane's
//! fixed format (16-bit mono at 48 kHz, whatever the device mixes at), keeps
//! the file on the wall clock through silences (`system_timeline`), and
//! follows the default output device when it changes mid-take (headphones
//! plugged in). The surface matches the macOS helper's, behind
//! `audio::system`.

use super::system::SystemLaneStatus;
use super::system_timeline::SilencePadder;
use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use crate::voice::resample::{to_mono, Resampler};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// The lane's own rate: the file never changes format when the device does.
const LANE_RATE: u32 = 48_000;
/// How long the worker waits for a packet before checking the clock.
const TICK: Duration = Duration::from_millis(50);
const DEVICE_CHECK_EVERY: Duration = Duration::from_secs(1);
/// The live preview tails the growing file; a flush makes new audio visible.
const FLUSH_EVERY: Duration = Duration::from_secs(1);
/// The level window, as the macOS helper measures it.
const LEVEL_WINDOW_FRAMES: usize = (LANE_RATE as usize * 80) / 1_000;
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// Packets in flight between the audio callback and the worker. Full means
/// the worker fell behind; a dropped packet becomes padded silence.
const CHANNEL_DEPTH: usize = 256;
const WAV_HEADER_BYTES: i64 = 44;
const NO_OUTPUT_MESSAGE: &str =
    "No sound output device is available. Connect speakers or headphones, then try again.";

struct Packet {
    generation: u64,
    channels: usize,
    samples: Vec<f32>,
}

pub struct SystemAudioCapture {
    worker: Option<thread::JoinHandle<Result<(), AppError>>>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    status: Arc<Mutex<SystemLaneStatus>>,
    partial_path: PathBuf,
    final_path: PathBuf,
}

impl SystemAudioCapture {
    pub fn start(
        partial_path: PathBuf,
        final_path: PathBuf,
        timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let status = Arc::new(Mutex::new(SystemLaneStatus::default()));
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), AppError>>(1);
        let worker = {
            let (stop, paused, status) = (stop.clone(), paused.clone(), status.clone());
            let path = partial_path.clone();
            thread::Builder::new()
                .name("system-audio-loopback".to_string())
                .spawn(move || {
                    run_worker(&path, timeline_offset, &stop, &paused, &status, ready_tx)
                })
                .map_err(|error| {
                    AppError::new("system_audio_capture_unavailable", error.to_string())
                })?
        };
        let error = match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {
                return Ok(Self {
                    worker: Some(worker),
                    stop,
                    paused,
                    status,
                    partial_path,
                    final_path,
                })
            }
            Ok(Err(error)) => error,
            Err(_) => AppError::new(
                "system_audio_capture_unavailable",
                "The computer's sound did not start in time.",
            ),
        };
        stop.store(true, Ordering::Release);
        let _ = worker.join();
        let _ = std::fs::remove_file(&partial_path);
        Err(error)
    }

    pub fn pause(&mut self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&mut self) {
        self.paused.store(false, Ordering::Release);
    }

    pub fn status(&self) -> SystemLaneStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    /// Stops the worker, which pads the lane up to now and finalizes the
    /// WAV, then commits `system.wav` by atomic rename (ADR-0005).
    pub fn stop(mut self) -> Result<PathBuf, AppError> {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            match worker.join() {
                Ok(result) => result?,
                Err(_) => {
                    return Err(AppError::new(
                        "audio_finalization_failed",
                        "The computer's sound stopped unexpectedly.",
                    ))
                }
            }
        }
        if self.partial_path.exists() {
            std::fs::rename(&self.partial_path, &self.final_path)
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        Ok(self.final_path.clone())
    }
}

impl Drop for SystemAudioCapture {
    // A capture dropped without `stop()` must not leave a thread recording.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Ready when there is a default output device to listen to. Loopback asks
/// for no permission, so the grant is never in question.
pub fn system_audio_readiness() -> SourceReadinessDto {
    let ready = cpal::default_host()
        .default_output_device()
        .is_some_and(|device| device.default_output_config().is_ok());
    SourceReadinessDto {
        source: RecordingSource::System,
        required: true,
        ready,
        permission_state: "granted".to_string(),
        device_available: ready,
        capture_available: ready,
        recovery_action: (!ready).then(|| "checkSoundOutput".to_string()),
        message: (!ready).then(|| NO_OUTPUT_MESSAGE.to_string()),
    }
}

/// Nothing to probe: Windows has no permission for loopback capture.
pub fn permission_check() -> Result<(), AppError> {
    Ok(())
}

struct Loopback {
    _stream: cpal::Stream,
    device_name: Option<String>,
    rate: u32,
}

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|device| device.name().ok())
}

fn send_packet(tx: &SyncSender<Packet>, generation: u64, channels: usize, samples: Vec<f32>) {
    // Never block the audio thread: a full queue drops the packet, and the
    // worker pads the gap it leaves.
    let _ = tx.try_send(Packet {
        generation,
        channels,
        samples,
    });
}

fn open_loopback(
    tx: &SyncSender<Packet>,
    generation: u64,
    failed: &Arc<AtomicBool>,
) -> Result<Loopback, AppError> {
    let unavailable = |message: String| AppError::new("system_audio_capture_unavailable", message);
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| unavailable(NO_OUTPUT_MESSAGE.to_string()))?;
    let device_name = device.name().ok();
    let config = device
        .default_output_config()
        .map_err(|error| unavailable(error.to_string()))?;
    let rate = config.sample_rate().0;
    let channels = usize::from(config.channels().max(1));
    let stream_config: cpal::StreamConfig = config.clone().into();
    let error_flag = failed.clone();
    let err_fn = move |error| {
        eprintln!("system audio loopback error: {error}");
        error_flag.store(true, Ordering::Release);
    };
    let tx = tx.clone();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| send_packet(&tx, generation, channels, data.to_vec()),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _| {
                let samples = data
                    .iter()
                    .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
                    .collect();
                send_packet(&tx, generation, channels, samples)
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _| {
                let samples = data
                    .iter()
                    .map(|sample| (f32::from(*sample) - 32_768.0) / 32_768.0)
                    .collect();
                send_packet(&tx, generation, channels, samples)
            },
            err_fn,
            None,
        ),
        other => {
            return Err(unavailable(format!(
                "Unsupported sound output format: {other:?}."
            )))
        }
    }
    .map_err(|error| unavailable(error.to_string()))?;
    stream
        .play()
        .map_err(|error| unavailable(error.to_string()))?;
    Ok(Loopback {
        _stream: stream,
        device_name,
        rate,
    })
}

/// RMS over 80 ms windows, reported as `min(1, rms * 4)`: the macOS helper's
/// scale, so the recorder's visual gain and the silence thresholds hold.
#[derive(Default)]
struct LevelMeter {
    sum_square: f64,
    frames: usize,
    level: f32,
    max_level: f32,
}

impl LevelMeter {
    fn push(&mut self, samples: &[f32]) {
        for sample in samples {
            self.sum_square += f64::from(*sample) * f64::from(*sample);
            self.frames += 1;
            if self.frames == LEVEL_WINDOW_FRAMES {
                let rms = (self.sum_square / self.frames as f64).sqrt() as f32;
                self.level = (rms * 4.0).min(1.0);
                self.max_level = self.max_level.max(self.level);
                self.sum_square = 0.0;
                self.frames = 0;
            }
        }
    }

    fn quiet(&mut self) {
        self.level = 0.0;
        self.sum_square = 0.0;
        self.frames = 0;
    }
}

struct LaneWriter {
    writer: WavWriter<BufWriter<File>>,
    padder: SilencePadder,
}

impl LaneWriter {
    fn write(&mut self, samples: &[f32]) -> Result<(), AppError> {
        for sample in samples {
            let pcm = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
            self.writer.write_sample(pcm).map_err(write_failed)?;
        }
        self.padder.record_written(samples.len() as u64);
        Ok(())
    }

    fn write_silence(&mut self, frames: u64) -> Result<(), AppError> {
        for _ in 0..frames {
            self.writer.write_sample(0_i16).map_err(write_failed)?;
        }
        self.padder.record_written(frames);
        Ok(())
    }
}

fn write_failed(error: hound::Error) -> AppError {
    AppError::new("audio_writer_failed", error.to_string())
}

fn run_worker(
    partial_path: &Path,
    timeline_offset: Duration,
    stop: &AtomicBool,
    paused: &AtomicBool,
    status: &Mutex<SystemLaneStatus>,
    ready_tx: SyncSender<Result<(), AppError>>,
) -> Result<(), AppError> {
    let (tx, rx) = mpsc::sync_channel::<Packet>(CHANNEL_DEPTH);
    let failed = Arc::new(AtomicBool::new(false));
    let mut generation = 0_u64;
    let opened = WavWriter::create(
        partial_path,
        WavSpec {
            channels: 1,
            sample_rate: LANE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    )
    .map_err(write_failed)
    .and_then(|writer| open_loopback(&tx, generation, &failed).map(|loopback| (writer, loopback)));
    let (writer, first) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        }
    };
    // The lane's clock starts `timeline_offset` before now: the padder owes
    // that much silence first, as the helper's `--timeline-offset-ms` does.
    let started = Instant::now();
    let now = || started.elapsed() + timeline_offset;
    let mut lane = LaneWriter {
        writer,
        padder: SilencePadder::new(LANE_RATE, Duration::ZERO),
    };
    let mut resampler = Resampler::new(first.rate, LANE_RATE);
    let mut loopback = Some(first);
    let _ = ready_tx.send(Ok(()));

    let mut meter = LevelMeter::default();
    let mut last_error: Option<String> = None;
    let mut last_packet_at: Option<Duration> = None;
    let mut was_paused = false;
    let mut last_device_check = Instant::now();
    let mut last_flush = Instant::now();
    let result = loop {
        let packet = rx.recv_timeout(TICK);
        let at = now();
        let paused_now = paused.load(Ordering::Acquire);
        if paused_now && !was_paused {
            // Up to the pause, then the clock freezes with the take.
            if let Err(error) = lane.write_silence(lane.padder.padding_to(at)) {
                break Err(error);
            }
            lane.padder.pause(at);
            meter.quiet();
            was_paused = true;
        } else if !paused_now && was_paused {
            lane.padder.resume(at);
            last_packet_at = Some(at);
            was_paused = false;
        }
        if stop.load(Ordering::Acquire) {
            break Ok(());
        }
        match packet {
            Ok(packet) if packet.generation == generation && !paused_now => {
                let mono = to_mono(&packet.samples, packet.channels);
                let samples = resampler.process(&mono);
                let pad = lane.padder.padding_before(at, samples.len() as u64);
                if let Err(error) = lane.write_silence(pad).and_then(|()| lane.write(&samples)) {
                    break Err(error);
                }
                meter.push(&samples);
                last_packet_at = Some(at);
            }
            // A packet from a stream replaced since, or one that arrived
            // while paused: not part of the take.
            Ok(_) | Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {}
        }
        let idle = lane.padder.idle_padding(at, last_packet_at);
        if idle > 0 {
            if let Err(error) = lane.write_silence(idle) {
                break Err(error);
            }
            meter.quiet();
        }
        if last_device_check.elapsed() >= DEVICE_CHECK_EVERY {
            last_device_check = Instant::now();
            let current = loopback
                .as_ref()
                .map(|loopback| loopback.device_name.clone());
            let device_changed = current.is_some_and(|name| name != default_output_name());
            if failed.swap(false, Ordering::AcqRel) || device_changed || loopback.is_none() {
                // Drop the old stream first: one loopback at a time.
                loopback = None;
                generation += 1;
                match open_loopback(&tx, generation, &failed) {
                    Ok(opened) => {
                        resampler = Resampler::new(opened.rate, LANE_RATE);
                        loopback = Some(opened);
                        last_error = None;
                    }
                    Err(error) => last_error = Some(error.message),
                }
            }
        }
        if last_flush.elapsed() >= FLUSH_EVERY {
            last_flush = Instant::now();
            let _ = lane.writer.flush();
        }
        if let Ok(mut shared) = status.lock() {
            *shared = SystemLaneStatus {
                level: AudioLevelDto {
                    peak: meter.level,
                    rms: meter.level,
                    recent_peaks: vec![meter.level],
                },
                max_level: meter.max_level,
                bytes_written: WAV_HEADER_BYTES + lane.padder.written() as i64 * 2,
                last_error: last_error.clone(),
            };
        }
    };
    drop(loopback);
    let end = now();
    let padded = lane.write_silence(lane.padder.padding_to(end));
    let finalized = lane.writer.finalize().map_err(write_failed);
    result.and(padded).and(finalized)
}
