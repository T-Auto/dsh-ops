use super::*;
use crate::contract::storage::StorageContext;
use serde_json::json;
fn fixture(body: impl FnOnce(&Cache, &std::path::Path)) {
    let root = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("ops-cache-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let mut request: Request =
        serde_json::from_value(json!({"root":root,"scope":"test","tool":"result","args":{}}))
            .unwrap();
    request.storage = Some(StorageContext {
        windows_write_sid: None,
        root: root.to_string_lossy().into(),
        authority_id: "a".repeat(64),
        allowed_tools: vec!["result".into()],
    });
    {
        let cache = Cache::open(&request).unwrap();
        body(&cache, &root);
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn production_caps_lru_and_orphans_preserve_non_cache_audits() {
    assert_eq!(MAX_RESULT_BYTES, 10 * 1024 * 1024);
    assert_eq!(MAX_SESSION_BYTES, 100 * 1024 * 1024);
    fixture(|cache, _| {
        let data = json!("x".repeat(MAX_RESULT_BYTES - 2)); // exact physical JSON cap
        let oversized = json!("x".repeat(MAX_RESULT_BYTES - 1));
        assert_eq!(
            cache
                .save(&uuid::Uuid::new_v4().to_string(), &oversized)
                .unwrap_err()
                .code,
            "QUOTA_EXCEEDED"
        );
        let ids: Vec<_> = (0..10).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        for id in &ids {
            assert_eq!(cache.save(id, &data).unwrap(), MAX_RESULT_BYTES);
        }
        // Touching the oldest result protects it; eviction must choose the next-oldest.
        cache.touch(&ids[0]).unwrap();
        let next = uuid::Uuid::new_v4().to_string();
        cache.save(&next, &data).unwrap();
        assert!(cache.read::<serde_json::Value>(&ids[0]).is_ok());
        assert_eq!(
            cache.read::<serde_json::Value>(&ids[1]).unwrap_err().code,
            "REFERENCE_EXPIRED"
        );
        let mut audit = cache_io::create_file(&cache.dir, "j-audit.json", None).unwrap();
        audit.write_all(b"never evict this audit").unwrap();
        drop(audit);
        // An interrupted stage consumes disk; save reclaims that exact temporary namespace.
        let orphan = format!("{}.tmp", uuid::Uuid::new_v4());
        let mut temporary = cache_io::create_file(&cache.dir, &orphan, None).unwrap();
        temporary.write_all(&vec![b'x'; 4096]).unwrap();
        drop(temporary);
        cache
            .save(&uuid::Uuid::new_v4().to_string(), &data)
            .unwrap();
        assert!(cache.dir.symlink_metadata(&orphan).is_err());
        let mut audit = cache_io::open_file(&cache.dir, "j-audit.json", false, None).unwrap();
        let mut contents = String::new();
        audit.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "never evict this audit");
        assert!(
            cache
                .entries()
                .unwrap()
                .iter()
                .map(|entry| entry.bytes)
                .sum::<u64>()
                <= MAX_SESSION_BYTES
        );
        // A repeated identity cannot evict its old record and then replace it.
        assert_eq!(
            cache.save(&next, &json!("replacement")).unwrap_err().code,
            "REVISION_CONFLICT"
        );
        let (unchanged, bytes) = cache.read::<serde_json::Value>(&next).unwrap();
        assert_eq!(unchanged, data);
        assert_eq!(bytes, MAX_RESULT_BYTES);
    });
}
#[test]
fn private_objects_reject_special_and_shared_inodes() {
    fixture(|cache, _| {
        let id = uuid::Uuid::new_v4().to_string();
        cache.save(&id, &json!({"x":1})).unwrap();
        let name = Cache::name(&id).unwrap();
        cache.dir.hard_link(&name, &cache.dir, "alias").unwrap();
        assert_eq!(
            cache.read::<serde_json::Value>(&id).unwrap_err().code,
            "PATH_RESTRICTED"
        );
        cache.dir.remove_file("alias").unwrap();
        assert!(cache.read::<serde_json::Value>(&id).is_ok());
        #[cfg(unix)]
        {
            use cap_std::fs::PermissionsExt;
            cache
                .dir
                .set_permissions(&name, cap_std::fs::Permissions::from_mode(0o644))
                .unwrap();
            assert_eq!(
                cache.read::<serde_json::Value>(&id).unwrap_err().code,
                "PATH_RESTRICTED"
            );
        }
    });
}

#[cfg(windows)]
#[test]
fn failed_purge_reports_partial_cache_effects_and_retains_the_lock() {
    use std::os::windows::fs::OpenOptionsExt;
    fixture(|cache, root| {
        let first = "00000000-0000-4000-8000-000000000001";
        let blocked = "00000000-0000-4000-8000-000000000002";
        cache.save(first, &json!({"x":1})).unwrap();
        cache.save(blocked, &json!({"x":2})).unwrap();
        let session = root.join(format!("s-{:x}", Sha256::digest(b"test")));
        // Holding the last canonical name without FILE_SHARE_DELETE deterministically
        // fails after the earlier snapshot was removed. This is an actual OS denial.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(session.join(Cache::name(blocked).unwrap()))
            .unwrap();
        let failure = cache.purge().unwrap_err();
        assert_eq!(failure.code, "CACHE_PURGE_FAILED");
        assert_eq!(&*failure.phase, "execute");
        assert_eq!(&*failure.effect_state, "partial");
        assert!(failure.next_action.contains("Never rerun business"));
        assert!(!session.join(Cache::name(first).unwrap()).exists());
        assert!(session.join(Cache::name(blocked).unwrap()).exists());
        assert!(session.join("lock").exists());
        drop(held);
        assert_eq!(cache.purge().unwrap(), (1, 1));
    });
}
