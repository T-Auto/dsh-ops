use super::{EXTENDED_FILE_ID_KEY, EXTENDED_PATH_KEY, read_path};
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString};

fn keys() -> (CFRetained<CFString>, CFRetained<CFString>) {
    (
        CFString::from_str(EXTENDED_PATH_KEY),
        CFString::from_str(EXTENDED_FILE_ID_KEY),
    )
}

#[test]
fn a_plain_cfstring_path_is_accepted_without_file_id() {
    let (path_key, file_id_key) = keys();
    let value = CFString::from_str("/tmp/plain");
    let array = CFArray::from_retained_objects(std::slice::from_ref(&value));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        Some(("/tmp/plain".to_string(), None))
    );
}

#[test]
fn a_dictionary_path_is_read_from_the_path_key() {
    let (path_key, file_id_key) = keys();
    let text = CFString::from_str("/tmp/extended");
    let dictionary = CFDictionary::from_slices(&[&*path_key], &[&*text]);
    let array = CFArray::from_retained_objects(std::slice::from_ref(&dictionary));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        Some(("/tmp/extended".to_string(), None))
    );
}

#[test]
fn a_non_string_path_value_is_rejected_instead_of_reinterpreted() {
    let (path_key, file_id_key) = keys();
    // The extended-data contract says `path` is a CFString; a CFNumber there is
    // a contract violation and must skip the event, not be read as a string.
    let number = CFNumber::new_i64(7);
    let dictionary = CFDictionary::from_slices(&[&*path_key], &[&*number]);
    let array = CFArray::from_retained_objects(std::slice::from_ref(&dictionary));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        None
    );
}

#[test]
fn a_non_number_file_id_is_ignored_instead_of_reinterpreted() {
    let (path_key, file_id_key) = keys();
    let text = CFString::from_str("/tmp/typed");
    let wrong_id = CFString::from_str("not-a-number");
    let dictionary = CFDictionary::from_slices(&[&*path_key, &*file_id_key], &[&*text, &*wrong_id]);
    let array = CFArray::from_retained_objects(std::slice::from_ref(&dictionary));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        Some(("/tmp/typed".to_string(), None))
    );
}

#[test]
fn a_dictionary_without_a_path_key_is_rejected() {
    let (path_key, file_id_key) = keys();
    let other_key = CFString::from_str("somethingElse");
    let text = CFString::from_str("/tmp/other");
    let dictionary = CFDictionary::from_slices(&[&*other_key], &[&*text]);
    let array = CFArray::from_retained_objects(std::slice::from_ref(&dictionary));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        None
    );
}

#[test]
fn a_number_under_the_file_id_key_is_accepted_but_a_path_is_still_required() {
    let (path_key, file_id_key) = keys();
    // Only the file id is present, so the event is rejected for its missing
    // path; the CFNumber type itself is what this case exercises.
    let number = CFNumber::new_i64(42);
    let dictionary = CFDictionary::from_slices(&[&*file_id_key], &[&*number]);
    let array = CFArray::from_retained_objects(std::slice::from_ref(&dictionary));
    assert_eq!(
        read_path(array.as_opaque(), 0, &path_key, &file_id_key),
        None
    );

    let text = CFString::from_str("/tmp/number");
    let path_dictionary = CFDictionary::from_slices(&[&*path_key], &[&*text]);
    let path_array = CFArray::from_retained_objects(std::slice::from_ref(&path_dictionary));
    assert_eq!(
        read_path(path_array.as_opaque(), 0, &path_key, &file_id_key),
        Some(("/tmp/number".to_string(), None))
    );
}
