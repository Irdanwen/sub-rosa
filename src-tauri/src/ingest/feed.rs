//! Finding the episode in a podcast feed.
//!
//! An RSS enclosure is the one link in this whole feature that was published
//! for exactly this purpose: a public URL, in a document whose entire reason
//! to exist is for clients to fetch it (ADR-0028). Feeds are also messy —
//! CDATA, namespaces, iTunes extensions, Atom's `<link rel="enclosure">` — so
//! this parses rather than pattern-matches, and takes the newest item with a
//! playable enclosure instead of assuming a document order.

use crate::domain::types::AppError;
use quick_xml::events::Event;
use quick_xml::Reader;

/// One episode worth fetching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedEpisode {
    pub media_url: String,
    pub title: Option<String>,
    /// The show's own title, when the feed carries one.
    pub show: Option<String>,
    pub mime_type: Option<String>,
}

/// Largest feed body worth parsing. Some shows publish a decade of episodes in
/// one document, and a few megabytes of XML is already generous.
pub const MAX_FEED_BYTES: usize = 8 * 1024 * 1024;

/// Extract the first playable episode from an RSS or Atom document.
///
/// "First" means first in document order, which every podcast host uses for
/// newest-first. An item without an enclosure is skipped rather than failing
/// the feed: shows routinely publish trailers and notes alongside episodes.
pub fn first_episode(xml: &str) -> Result<FeedEpisode, AppError> {
    let mut reader = Reader::from_str(xml);
    // No `trim_text`: a title arrives as several events (text, then each
    // entity, then text), and trimming each piece would glue "Tom & Jerry"
    // into "Tom&Jerry". The whole title is trimmed once, when it closes.
    reader.config_mut().check_end_names = false;

    let mut show: Option<String> = None;
    let mut in_item = false;
    // Where the text we are collecting should land.
    let mut collecting: Option<&'static str> = None;
    // The title being collected, assembled from every piece until it closes.
    let mut title_text = String::new();
    // An Atom title of `type="html"` is escaped once more, as HTML.
    let mut title_is_html = false;
    let mut item_title: Option<String> = None;
    let mut pending: Option<FeedEpisode> = None;
    let mut depth_title_seen_outside_item = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = local_name(element.name().as_ref());
                match name.as_str() {
                    "item" | "entry" => {
                        in_item = true;
                        item_title = None;
                    }
                    "title" => {
                        collecting = Some(if in_item { "item-title" } else { "show-title" });
                        title_text.clear();
                        title_is_html = element.attributes().flatten().any(|attribute| {
                            local_name(attribute.key.as_ref()) == "type"
                                && attribute
                                    .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                    .is_ok_and(|value| value.trim().eq_ignore_ascii_case("html"))
                        });
                    }
                    // RSS: <enclosure url="..." type="audio/mpeg"/>
                    // Atom: <link rel="enclosure" href="..." type="audio/mpeg"/>
                    "enclosure" | "link" => {
                        if !in_item {
                            continue;
                        }
                        let mut url = None;
                        let mut mime_type = None;
                        let mut is_enclosure = name == "enclosure";
                        for attribute in element.attributes().flatten() {
                            let key = local_name(attribute.key.as_ref());
                            let value = attribute
                                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .map(|value| value.trim().to_string())
                                .unwrap_or_default();
                            match key.as_str() {
                                "url" | "href" => url = Some(value),
                                "type" => mime_type = Some(value),
                                "rel" => is_enclosure = is_enclosure || value == "enclosure",
                                _ => {}
                            }
                        }
                        if !is_enclosure {
                            continue;
                        }
                        let Some(url) = url.filter(|url| !url.is_empty()) else {
                            continue;
                        };
                        if !mime_looks_playable(mime_type.as_deref(), &url) {
                            continue;
                        }
                        if pending.is_none() {
                            pending = Some(FeedEpisode {
                                media_url: url,
                                title: item_title.clone(),
                                show: show.clone(),
                                mime_type,
                            });
                        }
                    }
                    _ => collecting = None,
                }
            }
            // quick-xml asks which XML version's end-of-line rules to apply.
            // Feeds rarely carry a declaration, and the spec says a document
            // without one is 1.0.
            Ok(Event::Text(text)) if collecting.is_some() => {
                title_text.push_str(&text.xml_content(quick_xml::XmlVersion::Implicit1_0));
            }
            // Titles routinely carry entities (`&amp;`, `&#8217;`): each one is
            // its own event, between two pieces of text.
            Ok(Event::GeneralRef(reference)) if collecting.is_some() => {
                title_text.push_str(&entity(&reference));
            }
            // CDATA is already literal: unescaping it would be wrong.
            Ok(Event::CData(data)) if collecting.is_some() => title_text.push_str(&data),
            Ok(Event::End(element)) => {
                let name = local_name(element.name().as_ref());
                if name == "title" {
                    if let Some(target) = collecting.take() {
                        let text = title_text.trim();
                        let value = if title_is_html {
                            quick_xml::escape::unescape(text)
                                .map_or_else(|_| text.to_string(), |value| value.into_owned())
                        } else {
                            text.to_string()
                        };
                        absorb_title(
                            target,
                            value,
                            &mut show,
                            &mut item_title,
                            &mut depth_title_seen_outside_item,
                        );
                    }
                }
                if name == "item" || name == "entry" {
                    in_item = false;
                    // The enclosure may have been read before this item's
                    // title; fill it in now that the item is closed.
                    if let Some(episode) = pending.as_mut() {
                        if episode.title.is_none() {
                            episode.title = item_title.take();
                        }
                    }
                    if pending.is_some() {
                        break;
                    }
                }
                collecting = None;
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(AppError::new(
                    "ingest_feed_invalid",
                    format!("That feed could not be read: {error}"),
                ))
            }
            _ => {}
        }
    }

    let mut episode = pending.ok_or_else(|| {
        AppError::new(
            "ingest_feed_empty",
            "That feed has no episode this app can play.",
        )
    })?;
    if episode.show.is_none() {
        episode.show = show;
    }
    Ok(episode)
}

fn absorb_title(
    target: &'static str,
    value: String,
    show: &mut Option<String>,
    item_title: &mut Option<String>,
    show_title_seen: &mut bool,
) {
    if value.is_empty() {
        return;
    }
    match target {
        "item-title" => {
            if item_title.is_none() {
                *item_title = Some(value);
            }
        }
        // The channel's own title is the first one outside any item.
        _ => {
            if !*show_title_seen {
                *show = Some(value);
                *show_title_seen = true;
            }
        }
    }
}

/// What an entity reference stands for: a character reference, one of the
/// five XML predefines, or, for anything a feed did not declare (`&nbsp;`
/// pasted from HTML), the reference as written rather than nothing.
fn entity(reference: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(c)) = reference.resolve_char_ref() {
        return c.to_string();
    }
    match &**reference {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        other => format!("&{other};"),
    }
}

/// Strip any namespace prefix and lowercase, so `itunes:title` and `TITLE`
/// both read as `title`.
fn local_name(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase()
}

/// Whether an enclosure is audio or video rather than a transcript, an image
/// or a chapters file, which feeds also publish as enclosures.
fn mime_looks_playable(mime_type: Option<&str>, url: &str) -> bool {
    if let Some(mime_type) = mime_type.map(|value| value.to_ascii_lowercase()) {
        if mime_type.starts_with("audio/") || mime_type.starts_with("video/") {
            return true;
        }
        if !mime_type.is_empty() && mime_type != "application/octet-stream" {
            return false;
        }
    }
    super::link::path_extension(url).is_some_and(|extension| {
        matches!(
            extension.as_str(),
            "aac"
                | "aif"
                | "aiff"
                | "caf"
                | "flac"
                | "m4a"
                | "m4b"
                | "m4v"
                | "mka"
                | "mov"
                | "mp3"
                | "mp4"
                | "mpga"
                | "oga"
                | "ogg"
                | "ogv"
                | "opus"
                | "wav"
                | "webm"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Long Conversation</title>
    <item>
      <title><![CDATA[Episode 42: pricing]]></title>
      <enclosure url="https://cdn.example.com/ep/42.mp3" length="41231" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode 41</title>
      <enclosure url="https://cdn.example.com/ep/41.mp3" length="1" type="audio/mpeg"/>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn a_title_with_entities_is_read_whole() {
        // Each entity is its own event between two pieces of text; reading
        // only the first piece turned "Tom & Jerry's" into "Tom".
        let feed = "<rss><channel><title>Tom &amp; Jerry&#8217;s &lt;show&gt;</title>\
            <item><title>  Episode &quot;1&quot;, it&apos;s &nbsp;live  </title>\
            <enclosure url=\"https://e.com/a.mp3?x=1&amp;y=2\" type=\"audio/mpeg\"/>\
            </item></channel></rss>";
        let episode = first_episode(feed).unwrap();
        assert_eq!(episode.show.as_deref(), Some("Tom & Jerry\u{2019}s <show>"));
        assert_eq!(
            episode.title.as_deref(),
            Some("Episode \"1\", it's &nbsp;live")
        );
        assert_eq!(episode.media_url, "https://e.com/a.mp3?x=1&y=2");
    }

    #[test]
    fn an_atom_html_title_is_unescaped_once_more() {
        let feed = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">A &amp;amp; B</title>
            <entry><title type="html">Q&amp;amp;A &amp;#8212; live</title>
            <link rel="enclosure" href="https://e.com/v.m4a" type="audio/x-m4a"/></entry></feed>"#;
        let episode = first_episode(feed).unwrap();
        // Text is read as written; only HTML gets its second layer removed.
        assert_eq!(episode.show.as_deref(), Some("A &amp; B"));
        assert_eq!(episode.title.as_deref(), Some("Q&A \u{2014} live"));
    }

    #[test]
    fn takes_the_newest_episode_and_the_show_it_belongs_to() {
        let episode = first_episode(RSS).unwrap();

        assert_eq!(episode.media_url, "https://cdn.example.com/ep/42.mp3");
        assert_eq!(episode.title.as_deref(), Some("Episode 42: pricing"));
        assert_eq!(episode.show.as_deref(), Some("The Long Conversation"));
    }

    #[test]
    fn skips_enclosures_that_are_not_playable() {
        let xml = r#"<rss><channel><title>Show</title>
          <item>
            <title>With a transcript</title>
            <enclosure url="https://x.com/ep/1.srt" type="application/x-subrip"/>
            <enclosure url="https://x.com/ep/1.mp3" type="audio/mpeg"/>
          </item>
        </channel></rss>"#;

        let episode = first_episode(xml).unwrap();

        assert_eq!(episode.media_url, "https://x.com/ep/1.mp3");
    }

    #[test]
    fn reads_atom_enclosure_links_too() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom show</title>
          <entry>
            <title>An entry</title>
            <link rel="alternate" href="https://example.com/page"/>
            <link rel="enclosure" type="audio/mp4" href="https://cdn.example.com/a.m4a"/>
          </entry>
        </feed>"#;

        let episode = first_episode(xml).unwrap();

        assert_eq!(episode.media_url, "https://cdn.example.com/a.m4a");
        assert_eq!(episode.title.as_deref(), Some("An entry"));
        assert_eq!(episode.show.as_deref(), Some("Atom show"));
    }

    #[test]
    fn an_alternate_link_is_not_mistaken_for_an_enclosure() {
        let xml = r#"<feed><title>S</title><entry><title>E</title>
          <link rel="alternate" href="https://example.com/page.mp3"/>
        </entry></feed>"#;

        assert_eq!(first_episode(xml).unwrap_err().code, "ingest_feed_empty");
    }

    #[test]
    fn a_namespaced_or_uppercased_feed_still_parses() {
        let xml = r#"<rss><channel><TITLE>Loud show</TITLE>
          <item><itunes:title>Shouty</itunes:title>
            <ENCLOSURE URL="https://x.com/a.mp3" TYPE="audio/mpeg"/>
          </item></channel></rss>"#;

        let episode = first_episode(xml).unwrap();

        assert_eq!(episode.media_url, "https://x.com/a.mp3");
        assert_eq!(episode.show.as_deref(), Some("Loud show"));
    }

    #[test]
    fn an_octet_stream_enclosure_is_judged_by_its_extension() {
        let playable = r#"<rss><channel><item>
            <enclosure url="https://x.com/a.m4a" type="application/octet-stream"/>
        </item></channel></rss>"#;
        assert_eq!(
            first_episode(playable).unwrap().media_url,
            "https://x.com/a.m4a"
        );

        let not_playable = r#"<rss><channel><item>
            <enclosure url="https://x.com/notes.pdf" type="application/octet-stream"/>
        </item></channel></rss>"#;
        assert_eq!(
            first_episode(not_playable).unwrap_err().code,
            "ingest_feed_empty"
        );
    }

    #[test]
    fn a_feed_with_no_episodes_says_so_rather_than_failing_obscurely() {
        let xml = r#"<rss><channel><title>Empty</title></channel></rss>"#;
        assert_eq!(first_episode(xml).unwrap_err().code, "ingest_feed_empty");
    }

    #[test]
    fn html_that_is_not_a_feed_at_all_is_reported_as_empty_not_as_a_crash() {
        let error = first_episode("<html><body>not a feed</body></html>").unwrap_err();
        assert_eq!(error.code, "ingest_feed_empty");
    }
}
