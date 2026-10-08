//! What the app does with one frame from one connection (ADR-0100).
//!
//! Pure on purpose: the decision (who is asking, are they paired, is the
//! request well formed, what exactly gets written) is made here without a
//! database, a sidecar or a window, so every refusal is a unit test. The
//! server performs the [`Action`] it returns.

use chrono::{DateTime, Utc};

use super::pairing::PairingBook;
use super::protocol::{
    clean_page, clip, parse_request, Page, Request, Response, MAX_NOTE_TEXT_CHARS,
    MAX_QUESTION_CHARS, PROTOCOL_VERSION,
};

const MAX_CONVERSATION_ID_CHARS: usize = 64;

/// One connection's state: the origin the relay reported, once.
#[derive(Debug, Default)]
pub struct Session {
    origin: Option<String>,
}

/// A question to run as a chat turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskJob {
    pub id: String,
    /// The user message as the chat keeps it.
    pub content: String,
    /// The page's text, sent with this turn only (name, text).
    pub attachment: Option<(String, String)>,
    /// Continue this chat instead of starting one.
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Answer and do nothing else.
    Reply(Response),
    /// Remember the origin; no reply.
    Accept,
    Ask(AskJob),
    AddToNote {
        id: String,
        title: String,
        body: String,
    },
    SaveLink {
        id: String,
        page: Page,
    },
    Cancel {
        id: String,
        conversation_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    /// The pairing book changed and should be saved.
    pub book_changed: bool,
}

impl Decision {
    fn reply(response: Response) -> Self {
        Self {
            action: Action::Reply(response),
            book_changed: false,
        }
    }

    fn act(action: Action) -> Self {
        Self {
            action,
            book_changed: false,
        }
    }
}

const NOT_PAIRED: &str = "This browser is not connected to Sub Rosa any more. Pair it again.";
const NOT_A_PAGE: &str = "Sub Rosa can only read web pages (http or https).";

impl Session {
    pub fn decide(
        &mut self,
        book: &mut PairingBook,
        frame: &[u8],
        now: DateTime<Utc>,
        app_version: &str,
        fresh_token: impl FnOnce() -> String,
    ) -> Decision {
        let request = match parse_request(frame) {
            Ok(request) => request,
            Err(malformed) => {
                let message = if malformed.code == "unsupported_version" {
                    "Update Sub Rosa to use this version of the extension."
                } else {
                    "Sub Rosa did not understand that request."
                };
                return Decision::reply(Response::error(
                    malformed.id.as_deref(),
                    malformed.code,
                    message,
                ));
            }
        };
        if let Request::Origin { origin } = &request {
            if self.origin.is_some() || origin.trim().is_empty() {
                return Decision::reply(Response::error(None, "malformed", "Unexpected origin."));
            }
            self.origin = Some(origin.trim().to_string());
            return Decision::act(Action::Accept);
        }
        let Some(origin) = self.origin.clone() else {
            return Decision::reply(Response::error(
                None,
                "no_origin",
                "The browser did not say which extension is asking.",
            ));
        };
        match request {
            // Taken above; a second one is refused there.
            Request::Origin { .. } => Decision::act(Action::Accept),
            Request::Hello { id, token } => {
                let paired = token
                    .as_deref()
                    .is_some_and(|token| book.authenticate(token, &origin, now).is_some());
                Decision {
                    action: Action::Reply(Response::Hello {
                        id,
                        paired,
                        protocol: PROTOCOL_VERSION,
                        app_version: app_version.to_string(),
                    }),
                    book_changed: paired,
                }
            }
            Request::Pair { id, code, browser } => {
                let token = fresh_token();
                match book.redeem(&code, &origin, browser.as_deref(), &token, now) {
                    Ok(_) => Decision {
                        action: Action::Reply(Response::Paired { id, token }),
                        book_changed: true,
                    },
                    Err(error) => {
                        Decision::reply(Response::error(Some(&id), error.code(), error.message()))
                    }
                }
            }
            Request::Ask {
                id,
                token,
                question,
                page,
                conversation_id,
            } => {
                if book.authenticate(&token, &origin, now).is_none() {
                    return Decision::reply(Response::error(Some(&id), "not_paired", NOT_PAIRED));
                }
                let question = clip(&question, MAX_QUESTION_CHARS);
                if question.is_empty() {
                    return Decision::reply(Response::error(
                        Some(&id),
                        "empty_question",
                        "Type a question first.",
                    ));
                }
                let page = match page {
                    Some(page) => match clean_page(&page) {
                        Some(page) => Some(page),
                        None => {
                            return Decision::reply(Response::error(
                                Some(&id),
                                "page_not_supported",
                                NOT_A_PAGE,
                            ))
                        }
                    },
                    None => None,
                };
                let conversation_id = match conversation_id.map(|value| value.trim().to_string()) {
                    Some(value) if value.is_empty() => None,
                    Some(value) if value.chars().count() > MAX_CONVERSATION_ID_CHARS => {
                        return Decision::reply(Response::error(
                            Some(&id),
                            "malformed",
                            "Sub Rosa did not understand that request.",
                        ))
                    }
                    other => other,
                };
                let (content, attachment) = compose_question(&question, page.as_ref());
                Decision::act(Action::Ask(AskJob {
                    id,
                    content,
                    attachment,
                    conversation_id,
                }))
            }
            Request::AddToNote {
                id,
                token,
                page,
                text,
            } => {
                if book.authenticate(&token, &origin, now).is_none() {
                    return Decision::reply(Response::error(Some(&id), "not_paired", NOT_PAIRED));
                }
                let Some(page) = clean_page(&page) else {
                    return Decision::reply(Response::error(
                        Some(&id),
                        "page_not_supported",
                        NOT_A_PAGE,
                    ));
                };
                let (title, body) = compose_note(&page, &clip(&text, MAX_NOTE_TEXT_CHARS));
                Decision::act(Action::AddToNote { id, title, body })
            }
            Request::SaveLink { id, token, page } => {
                if book.authenticate(&token, &origin, now).is_none() {
                    return Decision::reply(Response::error(Some(&id), "not_paired", NOT_PAIRED));
                }
                match clean_page(&page) {
                    Some(page) => Decision::act(Action::SaveLink { id, page }),
                    None => Decision::reply(Response::error(
                        Some(&id),
                        "page_not_supported",
                        NOT_A_PAGE,
                    )),
                }
            }
            Request::Cancel {
                id,
                token,
                conversation_id,
            } => {
                if book.authenticate(&token, &origin, now).is_none() {
                    return Decision::reply(Response::error(Some(&id), "not_paired", NOT_PAIRED));
                }
                Decision::act(Action::Cancel {
                    id,
                    conversation_id: conversation_id.trim().to_string(),
                })
            }
            Request::Unpair { id, token } => {
                let Some(paired) = book.authenticate(&token, &origin, now) else {
                    // Already forgotten: the extension wanted exactly this.
                    return Decision::reply(Response::Unpaired { id });
                };
                book.forget(&paired);
                Decision {
                    action: Action::Reply(Response::Unpaired { id }),
                    book_changed: true,
                }
            }
        }
    }
}

/// `[title](url)`, the title's brackets escaped so the link stays a link.
fn markdown_link(title: &str, url: &str) -> String {
    let title = title
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    let url = url.replace(')', "%29").replace(' ', "%20");
    format!("[{title}]({url})")
}

fn quote(text: &str) -> String {
    text.lines()
        .map(|line| format!("> {line}").trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The user message a question becomes, and the page text that rides along
/// with this turn. The chat keeps the question, the selection and the link;
/// the page's text is an attachment, marked like any other (`[File: …]`), so
/// a turn resumed without it fails cleanly rather than guessing.
pub fn compose_question(question: &str, page: Option<&Page>) -> (String, Option<(String, String)>) {
    let mut content = question.to_string();
    let Some(page) = page else {
        return (content, None);
    };
    if !page.selection.is_empty() {
        content.push_str("\n\n");
        content.push_str(&quote(&page.selection));
    }
    content.push_str("\n\n");
    content.push_str(&markdown_link(&page.title, &page.url));
    if page.text.is_empty() {
        return (content, None);
    }
    content.push_str(&format!("\n\n[File: {}]", page.title));
    (content, Some((page.title.clone(), page.text.clone())))
}

/// The note "Add to a note" writes: what was chosen (the text the extension
/// sent, else the selection), then the page's link, which needs no label in
/// any language.
pub fn compose_note(page: &Page, text: &str) -> (String, String) {
    let mut body = String::new();
    if !text.is_empty() {
        body.push_str(text);
        body.push_str("\n\n");
    } else if !page.selection.is_empty() {
        body.push_str(&quote(&page.selection));
        body.push_str("\n\n");
    }
    body.push_str(&markdown_link(&page.title, &page.url));
    (page.title.clone(), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "chrome-extension://aphalahbhpimjbfdkjkdfgfbohboceig/";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-08T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn origin_frame(origin: &str) -> Vec<u8> {
        serde_json::json!({"type": "origin", "origin": origin})
            .to_string()
            .into_bytes()
    }

    fn decide(session: &mut Session, book: &mut PairingBook, value: serde_json::Value) -> Decision {
        session.decide(book, value.to_string().as_bytes(), now(), "1.0.0", || {
            "tok".to_string()
        })
    }

    /// A session already told its origin, and a book with "tok" paired to it.
    fn paired() -> (Session, PairingBook) {
        let mut session = Session::default();
        let mut book = PairingBook::default();
        session.decide(&mut book, &origin_frame(ORIGIN), now(), "1", String::new);
        book.begin("123456".into(), now());
        book.redeem("123456", ORIGIN, None, "tok", now()).unwrap();
        (session, book)
    }

    fn error_code(decision: &Decision) -> Option<&str> {
        match &decision.action {
            Action::Reply(Response::Error { code, .. }) => Some(code),
            _ => None,
        }
    }

    #[test]
    fn nothing_is_answered_before_the_relay_names_the_origin() {
        let mut session = Session::default();
        let mut book = PairingBook::default();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"hello","id":"1"}),
        );
        assert_eq!(error_code(&decision), Some("no_origin"));
        // And the origin cannot be changed afterwards by the extension.
        session.decide(&mut book, &origin_frame(ORIGIN), now(), "1", String::new);
        let again = session.decide(
            &mut book,
            &origin_frame("chrome-extension://evil/"),
            now(),
            "1",
            String::new,
        );
        assert_eq!(error_code(&again), Some("malformed"));
    }

    #[test]
    fn pairing_hands_out_a_token_and_hello_recognises_it() {
        let mut session = Session::default();
        let mut book = PairingBook::default();
        session.decide(&mut book, &origin_frame(ORIGIN), now(), "1", String::new);
        let hello = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"hello","id":"1"}),
        );
        assert!(matches!(
            hello.action,
            Action::Reply(Response::Hello { paired: false, .. })
        ));
        book.begin("123456".into(), now());
        let pair = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"pair","id":"2","code":"123-456","browser":"edge"}),
        );
        assert_eq!(
            pair.action,
            Action::Reply(Response::Paired {
                id: "2".into(),
                token: "tok".into()
            })
        );
        assert!(pair.book_changed);
        let hello = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"hello","id":"3","token":"tok"}),
        );
        assert!(matches!(
            hello.action,
            Action::Reply(Response::Hello { paired: true, .. })
        ));
    }

    #[test]
    fn a_wrong_code_is_named() {
        let mut session = Session::default();
        let mut book = PairingBook::default();
        session.decide(&mut book, &origin_frame(ORIGIN), now(), "1", String::new);
        let pair = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"pair","id":"2","code":"1"}),
        );
        assert_eq!(error_code(&pair), Some("pairing_not_started"));
        book.begin("123456".into(), now());
        let pair = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"pair","id":"2","code":"1"}),
        );
        assert_eq!(error_code(&pair), Some("pairing_wrong_code"));
    }

    #[test]
    fn every_action_needs_a_paired_token() {
        let (mut session, mut book) = paired();
        let page = serde_json::json!({"url":"https://example.com","title":"Ex"});
        for request in [
            serde_json::json!({"type":"ask","id":"1","token":"nope","question":"Hi"}),
            serde_json::json!({"type":"add_to_note","id":"1","token":"nope","page":page}),
            serde_json::json!({"type":"save_link","id":"1","token":"nope","page":page}),
            serde_json::json!({"type":"cancel","id":"1","token":"nope","conversationId":"c"}),
        ] {
            assert_eq!(
                error_code(&decide(&mut session, &mut book, request)),
                Some("not_paired")
            );
        }
    }

    #[test]
    fn a_token_from_another_extension_is_refused() {
        let (_, mut book) = paired();
        let mut other = Session::default();
        other.decide(
            &mut book,
            &origin_frame("chrome-extension://other/"),
            now(),
            "1",
            String::new,
        );
        let decision = decide(
            &mut other,
            &mut book,
            serde_json::json!({"type":"ask","id":"1","token":"tok","question":"Hi"}),
        );
        assert_eq!(error_code(&decision), Some("not_paired"));
    }

    #[test]
    fn a_question_about_a_page_carries_its_text_as_an_attachment() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"ask","id":"9","token":"tok","question":"Summarize this page.",
                "page":{"url":"https://example.com/a","title":"A [draft]","text":"Body text","selection":"Key line"}}),
        );
        let Action::Ask(job) = decision.action else {
            panic!("not an ask: {decision:?}");
        };
        assert_eq!(job.id, "9");
        assert_eq!(
            job.content,
            "Summarize this page.\n\n> Key line\n\n[A \\[draft\\]](https://example.com/a)\n\n[File: A [draft]]"
        );
        assert_eq!(
            job.attachment,
            Some(("A [draft]".into(), "Body text".into()))
        );
        assert_eq!(job.conversation_id, None);
    }

    #[test]
    fn a_question_without_a_page_is_just_the_question() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"ask","id":"9","token":"tok","question":"  And then? ","conversationId":"c1"}),
        );
        assert_eq!(
            decision.action,
            Action::Ask(AskJob {
                id: "9".into(),
                content: "And then?".into(),
                attachment: None,
                conversation_id: Some("c1".into()),
            })
        );
        let empty = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"ask","id":"9","token":"tok","question":"   "}),
        );
        assert_eq!(error_code(&empty), Some("empty_question"));
    }

    #[test]
    fn a_browser_page_is_never_read() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"save_link","id":"1","token":"tok","page":{"url":"chrome://history"}}),
        );
        assert_eq!(error_code(&decision), Some("page_not_supported"));
    }

    #[test]
    fn add_to_a_note_keeps_the_text_and_the_link() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"add_to_note","id":"4","token":"tok","text":"The answer.",
                "page":{"url":"https://example.com/a","title":"A"}}),
        );
        assert_eq!(
            decision.action,
            Action::AddToNote {
                id: "4".into(),
                title: "A".into(),
                body: "The answer.\n\n[A](https://example.com/a)".into(),
            }
        );
        let (title, body) = compose_note(
            &Page {
                url: "https://example.com/a".into(),
                title: "A".into(),
                text: String::new(),
                selection: "one\ntwo".into(),
            },
            "",
        );
        assert_eq!(title, "A");
        assert_eq!(body, "> one\n> two\n\n[A](https://example.com/a)");
    }

    #[test]
    fn unpairing_forgets_the_token() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"unpair","id":"5","token":"tok"}),
        );
        assert!(decision.book_changed);
        assert!(book.browsers.is_empty());
        let again = decide(
            &mut session,
            &mut book,
            serde_json::json!({"type":"unpair","id":"6","token":"tok"}),
        );
        assert_eq!(
            again.action,
            Action::Reply(Response::Unpaired { id: "6".into() })
        );
    }

    #[test]
    fn a_newer_extension_is_told_to_update_the_app() {
        let (mut session, mut book) = paired();
        let decision = decide(
            &mut session,
            &mut book,
            serde_json::json!({"v":2,"type":"hello","id":"1"}),
        );
        assert_eq!(error_code(&decision), Some("unsupported_version"));
    }
}
