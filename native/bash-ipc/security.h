// Original MIT code: compatibility for MSYS IPC under DSH's restricted token.
// No token changes, impersonation, filesystem hooks, or access-denied retries.
#pragma once
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>

inline bool restricted_low_token(HANDLE token) {
    DWORD size = 0;
    GetTokenInformation(token, TokenRestrictedSids, nullptr, 0, &size);
    if (size < sizeof(TOKEN_GROUPS)) return false;
    auto groups = static_cast<TOKEN_GROUPS*>(HeapAlloc(GetProcessHeap(), 0, size));
    bool restricted = groups && GetTokenInformation(token, TokenRestrictedSids, groups, size, &size) && groups->GroupCount > 0;
    if (groups) HeapFree(GetProcessHeap(), 0, groups);
    if (!restricted) return false;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
    auto label = static_cast<TOKEN_MANDATORY_LABEL*>(HeapAlloc(GetProcessHeap(), 0, size));
    bool low = false;
    if (label && GetTokenInformation(token, TokenIntegrityLevel, label, size, &size)) {
        auto count = GetSidSubAuthorityCount(label->Label.Sid);
        low = count && *count && *GetSidSubAuthority(label->Label.Sid, *count - 1) <= SECURITY_MANDATORY_LOW_RID;
    }
    if (label) HeapFree(GetProcessHeap(), 0, label);
    return low;
}

// Add only the already-present logon restricting SID to this NEW IPC object's
// original ACL. Preserve explicit denies and original trustees. The Low label
// permits the token to reopen its own pipe/section; no disk label is modified.
struct IpcSecurity {
    SECURITY_DESCRIPTOR descriptor{};
    PSECURITY_DESCRIPTOR label = nullptr;
    PACL merged = nullptr;
    BYTE* groups = nullptr;
    BYTE* defaults = nullptr;
    bool ready = false;
    explicit IpcSecurity(PSECURITY_DESCRIPTOR original) {
        HANDLE token = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return;
        if (!restricted_low_token(token)) { CloseHandle(token); return; }
        DWORD size = 0;
        GetTokenInformation(token, TokenGroups, nullptr, 0, &size);
        groups = static_cast<BYTE*>(HeapAlloc(GetProcessHeap(), 0, size));
        if (groups && GetTokenInformation(token, TokenGroups, groups, size, &size)) {
            auto list = reinterpret_cast<TOKEN_GROUPS*>(groups);
            PSID logon = nullptr;
            for (DWORD i = 0; i < list->GroupCount; ++i)
                if ((list->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) logon = list->Groups[i].Sid;
            BOOL present = FALSE, defaulted = FALSE;
            PACL old = nullptr;
            bool valid = true;
            if (original) valid = GetSecurityDescriptorDacl(original, &present, &old, &defaulted) != FALSE;
            // A NULL/absent DACL must not accidentally become a logon-only ACL.
            if (valid && (!original || !present || !old)) {
                GetTokenInformation(token, TokenDefaultDacl, nullptr, 0, &size);
                defaults = static_cast<BYTE*>(HeapAlloc(GetProcessHeap(), 0, size));
                valid = defaults && GetTokenInformation(token, TokenDefaultDacl, defaults, size, &size);
                if (valid) old = reinterpret_cast<TOKEN_DEFAULT_DACL*>(defaults)->DefaultDacl;
            }
            EXPLICIT_ACCESSW entry{};
            entry.grfAccessPermissions = GENERIC_ALL;
            entry.grfAccessMode = GRANT_ACCESS;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.ptstrName = static_cast<LPWSTR>(logon);
            PACL sacl = nullptr;
            if (valid && old && logon && SetEntriesInAclW(1, &entry, old, &merged) == ERROR_SUCCESS &&
                ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;;NW;;;LW)", SDDL_REVISION_1, &label, nullptr) &&
                GetSecurityDescriptorSacl(label, &present, &sacl, &defaulted)) {
                ready = InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
                    SetSecurityDescriptorDacl(&descriptor, TRUE, merged, FALSE) &&
                    SetSecurityDescriptorSacl(&descriptor, TRUE, sacl, FALSE);
            }
        }
        CloseHandle(token);
    }
    ~IpcSecurity() {
        if (merged) LocalFree(merged);
        if (label) LocalFree(label);
        if (groups) HeapFree(GetProcessHeap(), 0, groups);
        if (defaults) HeapFree(GetProcessHeap(), 0, defaults);
    }
    IpcSecurity(const IpcSecurity&) = delete;
};

inline std::wstring object_name(HANDLE handle) {
    using Query = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject"));
    alignas(void*) BYTE bytes[4096]; ULONG length = 0;
    if (!query || query(handle, 1, bytes, sizeof(bytes), &length) < 0) return {};
    auto name = reinterpret_cast<UNICODE_STRING*>(bytes);
    if (!name->Buffer || name->Length % sizeof(wchar_t)) return {};
    return std::wstring(name->Buffer, name->Length / sizeof(wchar_t));
}
inline std::wstring attribute_name(POBJECT_ATTRIBUTES object) {
    if (!object || !object->ObjectName || !object->ObjectName->Buffer || object->ObjectName->Length % 2) return {};
    return std::wstring(object->ObjectName->Buffer, object->ObjectName->Length / 2);
}
inline bool hex_key(const std::wstring& key) {
    return key.size() == 16 && key.find_first_not_of(L"0123456789abcdefABCDEF") == std::wstring::npos;
}
