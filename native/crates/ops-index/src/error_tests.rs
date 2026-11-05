use super::*;

#[test]
fn every_error_has_a_stable_code() {
    let errors = [
        (
            Error::Truncated {
                what: "HEADER",
                offset: 0,
                need: 16,
                len: 10,
            },
            "INDEX_TRUNCATED",
        ),
        (
            Error::OffsetOutOfBounds {
                what: "NEXT",
                offset: 99,
                len: 16,
            },
            "INDEX_OFFSET_OUT_OF_BOUNDS",
        ),
        (
            Error::OffsetCycle {
                what: "NEXT",
                offset: 4,
                rel: 2,
                min: 8,
            },
            "INDEX_OFFSET_CYCLE",
        ),
        (
            Error::OddUtf16Length {
                what: "NAME",
                offset: 8,
                len: 3,
            },
            "INDEX_ODD_UTF16_LENGTH",
        ),
        (
            Error::NameTooLong {
                what: "NAME",
                offset: 8,
                len: 700,
                max: 510,
            },
            "INDEX_NAME_TOO_LONG",
        ),
    ];
    for (error, code) in errors {
        assert_eq!(error.code(), code);
    }
}

#[test]
fn display_names_the_structure_and_the_offset() {
    let error = Error::Truncated {
        what: "QUERY_FILE_LAYOUT_OUTPUT",
        offset: 0,
        need: 16,
        len: 10,
    };
    assert_eq!(
        error.to_string(),
        "QUERY_FILE_LAYOUT_OUTPUT truncated at offset 0: need 16 bytes, have 10"
    );
    let error = Error::OffsetCycle {
        what: "NEXT_NAME",
        offset: 56,
        rel: 4,
        min: 24,
    };
    assert_eq!(
        error.to_string(),
        "NEXT_NAME at offset 56 does not advance: relative offset 4 is below 24"
    );
    let error = Error::NameTooLong {
        what: "NAME",
        offset: 8,
        len: 700,
        max: 510,
    };
    assert_eq!(
        error.to_string(),
        "NAME at offset 8 has byte length 700, above the maximum of 510"
    );
}

#[test]
fn error_is_cloneable_comparable_and_a_std_error() {
    let error = Error::OddUtf16Length {
        what: "NAME",
        offset: 3,
        len: 5,
    };
    let clone = error.clone();
    assert_eq!(error, clone);
    assert_ne!(
        clone,
        Error::OddUtf16Length {
            what: "NAME",
            offset: 4,
            len: 5,
        }
    );
    let as_dyn: &dyn std::error::Error = &error;
    assert!(as_dyn.source().is_none());
}
