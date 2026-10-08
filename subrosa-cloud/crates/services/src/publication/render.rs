//! Markdown in, an allowlisted HTML fragment out (ADR 0097).
//!
//! Two independent walls, so one mistake is not enough. The markdown pass
//! never emits markup it did not write itself: raw HTML in the source becomes
//! visible text, an image becomes its description, a task box becomes a glyph.
//! The sanitizer then keeps only the tags and attributes listed here, only
//! web and mail links, and marks every link as one the service does not vouch
//! for. The page that carries the fragment adds a third: a policy that runs no
//! script at all.
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, html};
use std::collections::HashSet;

/// Tags a published page may contain. No `img` (a reader's browser would
/// fetch whatever address the author chose), no `input`, no `iframe`, no
/// `style`, no `form`.
const TAGS: &[&str] = &[
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];

/// Renders `markdown` to a sanitized fragment.
pub fn markdown_to_html(markdown: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events = Parser::new_ext(markdown, options).filter_map(|event| match event {
        // Raw markup is shown as what it is, never interpreted.
        Event::Html(raw) | Event::InlineHtml(raw) => Some(Event::Text(raw)),
        // The description stays, the address does not: the text events
        // between these two are the alt text.
        Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => None,
        Event::TaskListMarker(done) => Some(Event::Text(CowStr::Borrowed(if done {
            "\u{2611} "
        } else {
            "\u{2610} "
        }))),
        other => Some(other),
    });
    let mut rendered = String::with_capacity(markdown.len() * 3 / 2);
    html::push_html(&mut rendered, events);
    sanitize(&rendered)
}

/// The allowlist itself, separate so tests can feed it hostile HTML directly.
pub fn sanitize(fragment: &str) -> String {
    let schemes: HashSet<&str> = ["http", "https", "mailto"].into_iter().collect();
    ammonia::Builder::empty()
        .add_tags(TAGS)
        .add_tag_attributes("a", ["href", "title"])
        .add_tag_attributes("ol", ["start"])
        .url_schemes(schemes)
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(Some("nofollow noopener noreferrer ugc"))
        .clean_content_tags(
            ["script", "style", "template", "noscript"]
                .into_iter()
                .collect(),
        )
        .strip_comments(true)
        .clean(fragment)
        .to_string()
}

/// Escapes text for an HTML text node or a double-quoted attribute.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything that may execute, load or navigate, in the shapes people
    /// actually try. None of it may survive either wall.
    const XSS: &[&str] = &[
        "<script>alert(1)</script>",
        "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
        "<img src=x onerror=alert(1)>",
        "<svg onload=alert(1)>",
        "<svg><script>alert(1)</script></svg>",
        "<iframe src=\"javascript:alert(1)\"></iframe>",
        "<a href=\"javascript:alert(1)\">x</a>",
        "<a href=\"JaVaScRiPt:alert(1)\">x</a>",
        "<a href=\"java\tscript:alert(1)\">x</a>",
        "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">x</a>",
        "<a href=\"vbscript:msgbox(1)\">x</a>",
        "<body onload=alert(1)>",
        "<div style=\"background:url(javascript:alert(1))\">x</div>",
        "<style>body{display:none}</style>",
        "<link rel=stylesheet href=//evil.example/x.css>",
        "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">",
        "<base href=\"https://evil.example/\">",
        "<form action=https://evil.example><input name=p></form>",
        "<object data=x.swf></object><embed src=x.swf>",
        "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
        "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
        "<template><script>alert(1)</script></template>",
        "<!--<img src=x onerror=alert(1)>-->",
        "<p onclick=alert(1)>x</p>",
        "<a href=\"https://ok.example\" onmouseover=alert(1)>x</a>",
        "<details open ontoggle=alert(1)>",
        "<video><source onerror=alert(1)></video>",
        "<marquee onstart=alert(1)>",
    ];
    const MARKDOWN_XSS: &[&str] = &[
        "[x](javascript:alert(1))",
        "[x](JAVASCRIPT:alert(1))",
        "[x](  javascript:alert(1)  )",
        "[x](&#106;avascript:alert(1))",
        "[x](data:text/html,<script>alert(1)</script>)",
        "![x](javascript:alert(1))",
        "![tracker](https://evil.example/pixel.gif)",
        "<https://ok.example/\"onmouseover=\"alert(1)>",
        "[x](https://ok.example/\"onmouseover=\"alert(1))",
        "```html\n<script>alert(1)</script>\n```",
        "<div>\n\n<script>alert(1)</script>\n\n</div>",
        "[x]: javascript:alert(1)\n\n[link][x]",
        "<a href=\"javascript:alert(1)\">inline</a> after",
    ];

    /// Reads the output as a browser would and checks every element and
    /// attribute against the allowlist. Text may say anything: it is escaped,
    /// so a `<` in it is `&lt;` and never opens a tag.
    fn assert_inert(html: &str, input: &str) {
        let mut rest = html;
        while let Some(at) = rest.find('<') {
            let Some(end) = rest[at..].find('>') else {
                unreachable!("unclosed tag in {html:?} (from {input:?})");
            };
            let tag_end = at + end;
            let tag = &rest[at + 1..tag_end];
            let tag = tag.strip_prefix('/').unwrap_or(tag);
            let mut parts = tag.splitn(2, ' ');
            let name = parts.next().unwrap_or_default().trim_end_matches('/');
            assert!(
                TAGS.contains(&name),
                "<{name}> survived in {html:?} (from {input:?})"
            );
            let mut attributes = parts.next().unwrap_or_default().trim_end_matches('/');
            while let Some(eq) = attributes.find("=\"") {
                let attribute = attributes[..eq].trim();
                let Some(end) = attributes[eq + 2..].find('"') else {
                    unreachable!("an unquoted value in {html:?}");
                };
                let value_end = eq + 2 + end;
                let value = &attributes[eq + 2..value_end];
                assert!(
                    ["href", "title", "rel", "start"].contains(&attribute),
                    "{attribute}= survived in {html:?} (from {input:?})"
                );
                if attribute == "href" {
                    assert!(
                        ["https://", "http://", "mailto:"]
                            .iter()
                            .any(|scheme| value.starts_with(scheme)),
                        "href {value:?} survived in {html:?} (from {input:?})"
                    );
                    assert!(!value.contains('"') && !value.contains('<'));
                }
                attributes = &attributes[value_end + 1..];
            }
            rest = &rest[tag_end + 1..];
        }
    }

    #[test]
    fn hostile_html_never_survives_the_sanitizer() {
        for input in XSS {
            assert_inert(&sanitize(input), input);
        }
    }

    #[test]
    fn hostile_markdown_never_survives_either_wall() {
        for input in XSS.iter().chain(MARKDOWN_XSS) {
            assert_inert(&markdown_to_html(input), input);
        }
    }

    #[test]
    fn raw_markup_in_a_note_is_shown_not_run() {
        let html = markdown_to_html("Use <b>bold</b> carefully");
        assert!(html.contains("&lt;b&gt;bold&lt;/b&gt;"), "{html}");
    }

    #[test]
    fn ordinary_writing_keeps_its_shape() {
        let html = markdown_to_html(
            "# Title\n\nSome **bold**, *italic* and ~~gone~~ text with `code`.\n\n- one\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n[a link](https://example.org/page?x=1)\n\n![a chart](chart.png)",
        );
        for expected in [
            "<h1>Title</h1>",
            "<strong>bold</strong>",
            "<em>italic</em>",
            "<del>gone</del>",
            "<code>code</code>",
            "<li>one</li>",
            "\u{2611} done",
            "<table>",
            "<blockquote>",
            "a chart",
            "href=\"https://example.org/page?x=1\"",
            "rel=\"nofollow noopener noreferrer ugc\"",
        ] {
            assert!(html.contains(expected), "{expected:?} missing in {html}");
        }
        assert!(!html.contains("chart.png"), "{html}");
    }

    #[test]
    fn relative_and_fragment_links_are_dropped() {
        let html = markdown_to_html("[a](/account) [b](#top) [c](mailto:me@example.org)");
        assert!(!html.contains("/account"), "{html}");
        assert!(!html.contains("#top"), "{html}");
        assert!(html.contains("mailto:me@example.org"), "{html}");
    }

    #[test]
    fn escape_covers_attribute_and_text_contexts() {
        assert_eq!(
            escape("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }
}
