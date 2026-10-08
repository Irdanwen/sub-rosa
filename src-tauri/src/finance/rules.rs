//! Categorisation: the person's rules first, in their order, then a short
//! list of merchants every Swiss or French statement is full of. A rule
//! never overrides a category the person chose by hand, and a built-in one
//! never overrides theirs.

use super::text::normalize;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub pattern: String,
    pub is_regex: bool,
    pub category: String,
    pub position: i64,
}

/// A rule ready to test: plain text is compared without case or accents, a
/// regular expression without case. An expression that does not compile
/// matches nothing rather than failing an import.
pub struct Matcher {
    category: String,
    test: Test,
}

enum Test {
    Text(String),
    Regex(Option<regex::Regex>),
    Words(Vec<String>),
}

impl Matcher {
    pub fn new(rule: &Rule) -> Self {
        let test = if rule.is_regex {
            Test::Regex(
                regex::RegexBuilder::new(&rule.pattern)
                    .case_insensitive(true)
                    .size_limit(1 << 20)
                    .build()
                    .ok(),
            )
        } else {
            Test::Text(normalize(&rule.pattern))
        };
        Self {
            category: rule.category.clone(),
            test,
        }
    }

    fn matches(&self, raw: &str, normalized: &str, words: &[String]) -> bool {
        match &self.test {
            Test::Text(needle) => !needle.is_empty() && normalized.contains(needle.as_str()),
            Test::Regex(Some(regex)) => regex.is_match(raw),
            Test::Regex(None) => false,
            Test::Words(needle) => words
                .windows(needle.len())
                .any(|window| window == needle.as_slice()),
        }
    }
}

/// Whether a pattern is a regular expression this app can run.
pub fn valid_regex(pattern: &str) -> bool {
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .is_ok()
}

fn words(text: &str) -> Vec<String> {
    normalize(text)
        .split(|c: char| !c.is_alphanumeric() && c != '&')
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Merchants by whole word, so `sbb` files a train ticket without filing
/// every description that happens to contain those letters.
const BUILT_IN: &[(&str, &[&str])] = &[
    (
        "groceries",
        &[
            "migros",
            "coop",
            "denner",
            "aldi",
            "lidl",
            "volg",
            "spar",
            "manor food",
            "carrefour",
            "leclerc",
            "auchan",
            "intermarche",
            "monoprix",
            "franprix",
            "super u",
            "biocoop",
            "picard",
            "grand frais",
        ],
    ),
    (
        "dining",
        &[
            "restaurant",
            "mcdonald's",
            "mcdonalds",
            "burger king",
            "starbucks",
            "boulangerie",
            "backerei",
            "pizzeria",
            "uber eats",
            "deliveroo",
            "just eat",
            "smood",
            "eat.ch",
        ],
    ),
    (
        "transport",
        &[
            "sbb",
            "cff",
            "ffs",
            "sncf",
            "ratp",
            "tpg",
            "bls",
            "uber",
            "bolt",
            "mobility",
            "parking",
            "esso",
            "avia",
            "tamoil",
            "socar",
            "totalenergies",
            "navigo",
            "blablacar",
        ],
    ),
    (
        "utilities",
        &[
            "swisscom",
            "sunrise",
            "salt mobile",
            "edf",
            "engie",
            "romande energie",
            "ewz",
            "free mobile",
            "bouygues",
            "sfr",
            "orange",
            "serafe",
        ],
    ),
    (
        "subscriptions",
        &[
            "netflix",
            "spotify",
            "disney plus",
            "disney+",
            "apple.com/bill",
            "youtube premium",
            "amazon prime",
            "icloud",
            "deezer",
            "canal+",
        ],
    ),
    (
        "health",
        &[
            "pharmacie",
            "apotheke",
            "pharmacy",
            "amavita",
            "sun store",
            "hopital",
            "spital",
            "dentiste",
            "zahnarzt",
            "doctolib",
        ],
    ),
    (
        "insurance",
        &[
            "css",
            "helsana",
            "swica",
            "sanitas",
            "visana",
            "groupe mutuel",
            "assura",
            "concordia",
            "axa",
            "allianz",
            "mobiliar",
            "baloise",
            "generali",
            "maif",
            "macif",
            "matmut",
            "mutuelle",
        ],
    ),
    (
        "shopping",
        &[
            "amazon",
            "zalando",
            "galaxus",
            "digitec",
            "ikea",
            "manor",
            "fnac",
            "decathlon",
            "h&m",
            "zara",
            "interdiscount",
            "mediamarkt",
            "media markt",
            "brack",
            "aliexpress",
        ],
    ),
    (
        "leisure",
        &[
            "cinema",
            "kino",
            "pathe",
            "steam",
            "playstation",
            "nintendo",
            "ticketcorner",
            "fnac spectacles",
        ],
    ),
    (
        "travel",
        &[
            "airbnb",
            "booking.com",
            "easyjet",
            "lufthansa",
            "air france",
            "swiss international",
            "hotel",
            "expedia",
        ],
    ),
    (
        "taxes",
        &[
            "impot",
            "impots",
            "steuer",
            "steuerverwaltung",
            "dgfip",
            "administration fiscale",
        ],
    ),
    (
        "fees",
        &[
            "frais",
            "gebuhr",
            "gebuhren",
            "kontofuhrung",
            "cotisation carte",
            "commission",
        ],
    ),
    (
        "cash",
        &[
            "bancomat",
            "atm",
            "geldautomat",
            "retrait dab",
            "retrait especes",
            "distributeur",
        ],
    ),
    (
        "housing",
        &["loyer", "miete", "regie", "hypotheque", "hypothek"],
    ),
    (
        "income",
        &["salaire", "lohn", "salary", "gehalt", "stipendio"],
    ),
];

/// The person's rules, in order, then the built-in merchants.
pub struct Categorizer {
    own: Vec<Matcher>,
    built_in: Vec<Matcher>,
}

impl Categorizer {
    pub fn new(rules: &[Rule]) -> Self {
        let mut ordered = rules.to_vec();
        ordered.sort_by_key(|rule| rule.position);
        Self {
            own: ordered.iter().map(Matcher::new).collect(),
            built_in: BUILT_IN
                .iter()
                .flat_map(|(category, names)| {
                    names.iter().map(move |name| Matcher {
                        category: (*category).to_string(),
                        test: Test::Words(words(name)),
                    })
                })
                .collect(),
        }
    }

    /// The category for a transaction, or `None` when nothing knows it.
    pub fn categorize(&self, description: &str, counterparty: &str) -> Option<String> {
        let raw = format!("{description} {counterparty}");
        let normalized = normalize(&raw);
        let words = words(&raw);
        self.own
            .iter()
            .chain(self.built_in.iter())
            .find(|matcher| matcher.matches(&raw, &normalized, &words))
            .map(|matcher| matcher.category.clone())
    }
}

/// What a remembered choice matches: the counterparty when the statement
/// names one, otherwise the description without its dates, card numbers and
/// references (the words that stay the same from one month to the next).
pub fn pattern_for(description: &str, counterparty: &str) -> String {
    if !counterparty.trim().is_empty() {
        return counterparty.trim().to_string();
    }
    description
        .split_whitespace()
        .filter(|word| !word.chars().any(|c| c.is_ascii_digit()))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(pattern: &str, category: &str, is_regex: bool, position: i64) -> Rule {
        Rule {
            id: pattern.into(),
            pattern: pattern.into(),
            is_regex,
            category: category.into(),
            position,
        }
    }

    #[test]
    fn the_persons_rules_come_first_in_their_order() {
        let categorizer = Categorizer::new(&[
            rule("migros", "household", false, 2),
            rule("MIGROS BANK", "transfers", false, 1),
        ]);
        assert_eq!(
            categorizer.categorize("Migros Bank Zahlung", "").as_deref(),
            Some("transfers")
        );
        assert_eq!(
            categorizer.categorize("MIGROS M ZÜRICH", "").as_deref(),
            Some("household")
        );
    }

    #[test]
    fn built_in_merchants_match_whole_words_only() {
        let categorizer = Categorizer::new(&[]);
        assert_eq!(
            categorizer
                .categorize("SBB CFF FFS 1234 Billett", "")
                .as_deref(),
            Some("transport")
        );
        assert_eq!(
            categorizer
                .categorize("CARTE X1234 15/03 CARREFOUR MARKET", "")
                .as_deref(),
            Some("groceries")
        );
        // "tamoil" is a word; "salt" alone is not a mobile operator.
        assert_eq!(categorizer.categorize("Fleur de sel salt", ""), None);
        assert_eq!(
            categorizer
                .categorize("Paiement", "Swisscom (Schweiz) AG")
                .as_deref(),
            Some("utilities")
        );
    }

    #[test]
    fn a_regex_rule_and_a_broken_one() {
        let categorizer = Categorizer::new(&[
            rule("Carte \"Claude\"|Anthropic", "subscriptions", true, 0),
            rule("([unclosed", "never", true, 1),
        ]);
        assert_eq!(
            categorizer.categorize("PRLV ANTHROPIC PBC", "").as_deref(),
            Some("subscriptions")
        );
        assert!(!valid_regex("([unclosed"));
        assert_eq!(
            categorizer.categorize("Bäckerei Hug", "").as_deref(),
            Some("dining")
        );
    }

    #[test]
    fn a_remembered_choice_matches_what_recurs() {
        assert_eq!(
            pattern_for("ignored", "Helsana Versicherungen"),
            "Helsana Versicherungen"
        );
        assert_eq!(
            pattern_for("CARTE X1234 15/03 BOULANGERIE PAUL 75011", ""),
            "CARTE BOULANGERIE PAUL"
        );
    }
}
