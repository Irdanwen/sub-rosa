//! Study mode: the scheduling, the cards a deck adds, and the prompt seam.

use super::schedule::{review, CardState, Grade, MIN_EASE, RELEARN_MINUTES};
use super::*;
use chrono::{Duration, TimeZone};

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn at(day: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, day, 9, 0, 0).unwrap()
}

#[test]
fn good_answers_space_a_card_one_day_then_six_then_by_its_ease() {
    let now = at(1);
    let (first, due) = review(CardState::default(), Grade::Good, now);
    assert_eq!((first.repetitions, first.interval_days), (1, 1));
    assert_eq!(due, now + Duration::days(1));
    let (second, _) = review(first, Grade::Good, now);
    assert_eq!(second.interval_days, 6);
    let (third, due) = review(second, Grade::Good, now);
    // Good keeps the ease where it was (q = 4 moves it by zero).
    assert!((third.ease - 2.5).abs() < 1e-9);
    assert_eq!(third.interval_days, 15);
    assert_eq!(due, now + Duration::days(15));
}

#[test]
fn again_starts_the_card_over_inside_the_sitting_and_lowers_its_ease() {
    let learned = CardState {
        ease: 2.5,
        interval_days: 15,
        repetitions: 3,
        lapses: 0,
    };
    let now = at(2);
    let (lapsed, due) = review(learned, Grade::Again, now);
    assert_eq!(lapsed.repetitions, 0);
    assert_eq!(lapsed.lapses, 1);
    assert_eq!(lapsed.interval_days, 0);
    assert!((lapsed.ease - 2.3).abs() < 1e-9);
    assert_eq!(due, now + Duration::minutes(RELEARN_MINUTES));
}

#[test]
fn hard_grows_slower_than_good_and_easy_faster_and_ease_has_a_floor() {
    let learned = CardState {
        ease: 2.5,
        interval_days: 10,
        repetitions: 3,
        lapses: 0,
    };
    let now = at(3);
    let hard = review(learned, Grade::Hard, now).0;
    let good = review(learned, Grade::Good, now).0;
    let easy = review(learned, Grade::Easy, now).0;
    assert_eq!(hard.interval_days, 12);
    assert_eq!(good.interval_days, 25);
    assert_eq!(easy.interval_days, 33);
    assert!(hard.ease < good.ease && good.ease < easy.ease);
    let mut state = learned;
    for _ in 0..20 {
        state = review(state, Grade::Again, now).0;
    }
    assert!((state.ease - MIN_EASE).abs() < 1e-9);
    // Easy on a first answer still waits longer than Good would.
    assert_eq!(
        review(CardState::default(), Grade::Easy, now)
            .0
            .interval_days,
        2
    );
}

#[tokio::test]
async fn a_deck_is_added_once_due_now_and_comes_back_on_schedule() {
    let pool = pool().await;
    let request = AddCardsRequest {
        cards: vec![
            NewCard {
                front: "Capital of Peru".into(),
                back: "Lima".into(),
            },
            NewCard {
                front: "  capital of   PERU ".into(),
                back: "lima".into(),
            },
            NewCard {
                front: "Speed of light".into(),
                back: "299 792 km/s".into(),
            },
            NewCard {
                front: " ".into(),
                back: "nothing in front".into(),
            },
        ],
        deck: Some("Geography".into()),
        chat_id: Some("chat-1".into()),
    };
    let added = add_cards(&pool, &request, at(1)).await.unwrap();
    assert_eq!(
        added,
        AddCardsResult {
            added: 2,
            already: 1
        }
    );
    let again = add_cards(&pool, &request, at(1)).await.unwrap();
    assert_eq!(again.added, 0);

    let due = due_cards(&pool, at(1), 50).await.unwrap();
    assert_eq!(due.len(), 2);
    assert_eq!(due[0].deck.as_deref(), Some("Geography"));
    let reviewed = review_card(&pool, &due[0].id, Grade::Good, at(1))
        .await
        .unwrap();
    assert_eq!(reviewed.interval_days, 1);
    assert_eq!(reviewed.due_at, stamp(at(2)));

    let today = stats(&pool, at(1)).await.unwrap();
    assert_eq!((today.total, today.due), (2, 1));
    assert_eq!(today.next_due_at, Some(stamp(at(2))));
    assert_eq!(due_cards(&pool, at(2), 50).await.unwrap().len(), 2);
    assert!(review_card(&pool, "missing", Grade::Good, at(1))
        .await
        .is_err());
}

#[tokio::test]
async fn an_empty_or_oversized_deck_is_refused() {
    let pool = pool().await;
    let empty = AddCardsRequest {
        cards: vec![],
        deck: None,
        chat_id: None,
    };
    assert!(add_cards(&pool, &empty, at(1)).await.is_err());
    let huge = AddCardsRequest {
        cards: (0..51)
            .map(|index| NewCard {
                front: format!("q{index}"),
                back: "a".into(),
            })
            .collect(),
        deck: None,
        chat_id: None,
    };
    assert!(add_cards(&pool, &huge, at(1)).await.is_err());
}

#[tokio::test]
async fn the_phone_prompt_gains_the_tutor_only_while_the_chat_is_in_study_mode() {
    let pool = pool().await;
    let base = "You are Sub Rosa's assistant.".to_string();
    assert_eq!(prompted(&pool, "chat-1", base.clone()).await, base);
    assert!(set_mode(&pool, "chat-1", true).await.unwrap());
    let studying = prompted(&pool, "chat-1", base.clone()).await;
    assert!(studying.starts_with(&base));
    assert!(studying.contains("subrosa:quiz"));
    assert!(studying.contains("subrosa:flashcards"));
    // Setting it twice is harmless, and another chat is untouched.
    set_mode(&pool, "chat-1", true).await.unwrap();
    assert_eq!(prompted(&pool, "chat-2", base.clone()).await, base);
    assert!(!set_mode(&pool, "chat-1", false).await.unwrap());
    assert_eq!(prompted(&pool, "chat-1", base.clone()).await, base);
    assert!(set_mode(&pool, "  ", true).await.is_err());
}
