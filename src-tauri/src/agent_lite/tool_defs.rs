//! The tools agent-lite offers the model on every turn, before the per-turn
//! additions (a project's files, Python, an assistant's references). Kept
//! apart from the loop in `mod.rs` so the loop stays readable.

pub(super) fn tool_definitions(memory_enabled: bool) -> serde_json::Value {
    let mut tools = vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "Search the user's local meeting notes and transcripts. Returns matching snippets with note titles and dates.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short keyword query (2 to 6 words), in the language of the notes."
                        }
                    },
                    "required": ["query"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the public web for current information.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Web search query." }
                    },
                    "required": ["query"]
                }
            }
        }),
    ];
    // The production surface, kept to the same two tools the desktop MCP has.
    // Deliberately no render tool: the phone's agent can describe and prepare a
    // film, and the spending happens where the user sees the figure.
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "bible",
            "description": "The persistent identities of a production: characters, locations, props, the look. A character named here keeps their face and their described traits across every shot, which is what makes separately generated clips look like one film. Actions: list, save (name, kind, traits, id to update), delete (id).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "save", "delete"] },
                    "id": { "type": "string" },
                    "kind": { "type": "string", "enum": ["character", "location", "prop", "look"] },
                    "name": { "type": "string" },
                    "traits": { "type": "string", "description": "What must not drift between shots." }
                },
                "required": ["action"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "shots",
            "description": "Read one of the user's notes as the shots a film is made of. Actions: plan (what it would take, and whether it can be read at all), build (start reading - it runs in the background and survives the app closing), read (the current state and the shots). Always plan first and tell the user what it will take. Compiling the shots into a film and paying for it happens in the Studio, not here.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["plan", "build", "read"] },
                    "noteId": { "type": "string" }
                },
                "required": ["action", "noteId"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "search_calendar",
            "description": "Look at the user's calendar for a day: what meetings there are, when, and who is invited. Use it when the question is about their schedule, or to find which meeting a note belongs to. It reads the device's calendar and returns only the window you ask for.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Optional words to filter on (a title or an attendee). Leave empty for the whole window."
                    },
                    "days": {
                        "type": "integer",
                        "description": "Days ahead (positive) or back (negative), at most 7. 0 or 1 means today."
                    }
                },
                "required": []
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "places_search",
            "description": "Find real-world places (businesses, offices, restaurants, landmarks) by name or kind, optionally near a point. Returns names, coordinates, addresses and categories. When you answer with these results, embed them as a subrosa:places chat block, copying the JSON fields verbatim.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to look for, including the area when known (e.g. 'expert comptable Annemasse')."
                    },
                    "near": {
                        "type": "object",
                        "properties": {
                            "lat": { "type": "number" },
                            "lng": { "type": "number" }
                        },
                        "required": ["lat", "lng"],
                        "description": "Bias results toward this point."
                    }
                },
                "required": ["query"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": "Open a web page and read its text. Use it after web_search when the snippets do not actually answer the question: the snippet is a couple of sentences, the page is the source. Also use it when the user gives you a URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full URL, normally taken from a web_search result."
                    }
                },
                "required": ["url"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "summarize_note",
            "description": "Read a long recording end to end and write a faithful account of it, with timestamped chapters. Use this for a talk, a lecture, an interview or a podcast, where the value is the argument rather than the decisions. It costs several model calls and takes minutes, so ask the user before starting one, and never start one just to answer a question read_note could answer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The noteId from a previous search_notes, list_recent_notes or import result."
                    }
                },
                "required": ["note_id"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "import_link",
            "description": "Turn a link into a note: fetch a podcast feed, a podcast episode or a direct audio or video URL, transcribe it, and write a note. Streaming platform pages (YouTube, Spotify, Vimeo and the like) do not work and will say so. The download happens on the user's machine, so say that it is starting rather than promising the result immediately.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "A podcast feed URL, a podcast episode URL, or a direct link to an audio or video file."
                    }
                },
                "required": ["url"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "read_note",
            "description": "Read one note in full: its written note and its transcript. Use this after search_notes or list_recent_notes whenever the question is about what a note actually says (summarising it, listing its decisions, quoting it). Search only returns a short window around a keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The noteId from a previous search_notes or list_recent_notes result."
                    }
                },
                "required": ["note_id"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_recent_notes",
            "description": "List the user's most recent notes, newest first, with their ids, titles and previews. Use this for questions about a period rather than a keyword (\"what did I do this week\"), or to find a note when you do not know what to search for.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "How many notes to list, 1 to 30. Defaults to 10."
                    }
                }
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_note",
            "description": "Create a new note in the user's notes. Use it when the user asks you to write something down, draft something, or save a summary. Do not use it to answer a question: answer in the conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short title, in the user's language." },
                    "content": { "type": "string", "description": "The note body, in markdown." }
                },
                "required": ["content"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "append_to_note",
            "description": "Add text to the end of an existing note. Use it when the user asks to add something to a note that already exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "The noteId to append to." },
                    "content": { "type": "string", "description": "The text to add, in markdown." }
                },
                "required": ["note_id", "content"]
            }
        }
    }));
    // Word, Excel and PowerPoint files, made by the same writers as on the
    // desktop (ADR-0090).
    tools.push(crate::deliverables::tool_definition());
    if memory_enabled {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "remember",
                "description": "Store a durable fact about the user so it is available in every future conversation. Use it when the user explicitly asks you to remember something, or states a lasting preference or constraint. Do not use it for one-off details of the current conversation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "The fact, as one self-contained sentence in the user's language."
                        }
                    },
                    "required": ["text"]
                }
            }
        }));
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_memories",
                "description": "Search durable facts remembered about the user from past conversations (preferences, projects, constraints). The most important facts are already in your context; use this to look up more when the user references something from an earlier conversation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short keyword query, in the user's language."
                        }
                    },
                    "required": ["query"]
                }
            }
        }));
        tools.extend(crate::memory::past_chats::tool_definition());
    }
    serde_json::Value::Array(tools)
}
