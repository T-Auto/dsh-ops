use super::*;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[test]
fn a_drive_root_becomes_a_device_path() {
    for spelling in ["C:", "C:\\", "c:/", "c:"] {
        assert_eq!(
            device_path(spelling).unwrap_or_else(|_| panic!("{spelling}")),
            wide(r"\\.\C:"),
            "{spelling}"
        );
    }
    assert_eq!(device_path("D:\\").expect("another drive"), wide(r"\\.\D:"));
}

#[test]
fn a_verbatim_drive_root_is_stripped() {
    assert_eq!(
        device_path(r"\\?\C:\").expect("a verbatim drive root"),
        wide(r"\\.\C:")
    );
}

#[test]
fn a_drive_relative_tail_keeps_the_volume() {
    // C:some\dir is relative to that drive's current directory, not a volume
    // root; the handle still addresses the volume.
    assert_eq!(
        device_path(r"C:some\dir").expect("a drive-relative path"),
        wide(r"\\.\C:")
    );
}

#[test]
fn a_path_that_is_not_a_drive_volume_is_unsupported() {
    for spelling in [
        r"C:\sub",
        r"\\server\share",
        r"\\?\UNC\server\share",
        r"\\?\Volume{0000}",
        "relative",
        "",
    ] {
        assert_eq!(
            device_path(spelling).unwrap_err(),
            WinfsError::Unsupported,
            "{spelling}"
        );
    }
}
