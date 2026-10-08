//! Sample-rate conversion for the voice loop: the microphone's rate down to
//! the detector's 16 kHz, and a spoken sentence's rate to the speaker's.
//!
//! Linear interpolation. It is not a mastering resampler, and it does not
//! need to be: speech recognition reads 16 kHz voice band, and the replies
//! are speech too. What matters here is that it streams (the microphone
//! arrives in callbacks of any size) without clicks at the seams.

/// Mixes interleaved frames down to mono.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// A streaming linear resampler for one channel.
#[derive(Clone, Debug)]
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Position of the next output sample, in input samples, relative to
    /// `previous` (0.0 is `previous` itself).
    position: f64,
    previous: Option<f32>,
}

impl Resampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            step: f64::from(from_rate.max(1)) / f64::from(to_rate.max(1)),
            position: 0.0,
            previous: None,
        }
    }

    /// Converts the next block of input, carrying the phase to the next call.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        if (self.step - 1.0).abs() < f64::EPSILON {
            return input.to_vec();
        }
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 2);
        // Index -1 is the last sample of the previous block.
        let sample = |index: isize, previous: Option<f32>| -> f32 {
            if index < 0 {
                previous.unwrap_or(input[0])
            } else {
                // Exactly on the last sample the next one weighs nothing.
                input
                    .get(index as usize)
                    .or(input.last())
                    .copied()
                    .unwrap_or(0.0)
            }
        };
        let mut position = if self.previous.is_some() {
            self.position - 1.0
        } else {
            self.position
        };
        while position <= (input.len() - 1) as f64 {
            let base = position.floor();
            let fraction = (position - base) as f32;
            let index = base as isize;
            let a = sample(index, self.previous);
            let b = sample(index + 1, self.previous);
            out.push(a + (b - a) * fraction);
            position += self.step;
        }
        self.position = position - (input.len() - 1) as f64;
        self.previous = input.last().copied();
        out
    }
}

/// Converts a whole clip at once.
pub fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    Resampler::new(from_rate, to_rate).process(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_averages_the_channels() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.25, 0.75], 1), vec![0.25, 0.75]);
    }

    #[test]
    fn the_length_follows_the_ratio() {
        let one_second = vec![0.0; 48_000];
        let out = resample(&one_second, 48_000, 16_000);
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
        let up = resample(&vec![0.0; 24_000], 24_000, 48_000);
        assert!((up.len() as i64 - 48_000).abs() <= 2, "{}", up.len());
        assert_eq!(resample(&[0.1, 0.2], 16_000, 16_000), vec![0.1, 0.2]);
    }

    #[test]
    fn streaming_in_blocks_matches_one_pass() {
        let input: Vec<f32> = (0..4_410).map(|i| (i as f32 * 0.01).sin()).collect();
        let whole = resample(&input, 44_100, 16_000);
        let mut streaming = Resampler::new(44_100, 16_000);
        let mut blocks = Vec::new();
        for block in input.chunks(437) {
            blocks.extend(streaming.process(block));
        }
        assert_eq!(blocks.len(), whole.len());
        for (a, b) in blocks.iter().zip(&whole) {
            assert!((a - b).abs() < 1.0e-5);
        }
    }

    #[test]
    fn a_ramp_stays_a_ramp() {
        let ramp: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let up = resample(&ramp, 1, 2);
        for pair in up.windows(2) {
            assert!((pair[1] - pair[0] - 0.5).abs() < 1.0e-4);
        }
    }
}
