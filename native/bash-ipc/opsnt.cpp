#include "security.h"
// Only new private MSYS named pipes and pagefile-backed process/user sections.
// NtCreateFile/NtOpenFile and token APIs remain unmodified forwarders.
inline bool selected_pipe(POBJECT_ATTRIBUTES object) {
    if (!object || !object->RootDirectory || object_name(object->RootDirectory) != L"\\Device\\NamedPipe\\") return false;
    auto name = attribute_name(object);
    auto marker = L"-" + std::to_wstring(GetCurrentProcessId()) + L"-pipe-nt-0x";
    return name.size() > 16 + marker.size() && hex_key(name.substr(0,16)) &&
        name.substr(16,marker.size()) == marker && name.substr(16 + marker.size()).find_first_not_of(L"0123456789abcdefABCDEF") == std::wstring::npos;
}
inline bool current_user_section(const std::wstring& name) {
    const auto dot = name.find_last_of(L'.');
    if (dot == std::wstring::npos || dot + 1 == name.size() ||
        name.substr(dot + 1).find_first_not_of(L"0123456789") != std::wstring::npos) return false;
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    alignas(void*) BYTE bytes[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]; DWORD size = 0;
    const bool queried = GetTokenInformation(token, TokenUser, bytes, sizeof(bytes), &size) != FALSE;
    CloseHandle(token);
    if (!queried) return false;
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes)->User.Sid, &sid)) return false;
    const bool selected = name.substr(0, dot) == sid;
    LocalFree(sid);
    return selected;
}
inline bool selected_section(POBJECT_ATTRIBUTES object, HANDLE file) {
    if (file || !object || !object->RootDirectory) return false;
    auto root = object_name(object->RootDirectory);
    const std::wstring prefix = L"\\BaseNamedObjects\\msys-2.0S5-";
    if (!root.starts_with(prefix) || !hex_key(root.substr(prefix.size()))) return false;
    auto name = attribute_name(object);
    return (name.starts_with(L"cygpid.") && name.size() > 7 && name.substr(7).find_first_not_of(L"0123456789") == std::wstring::npos)
        || current_user_section(name);
}
extern "C" NTSTATUS NTAPI OpsNtCreateNamedPipeFile(PHANDLE handle, ULONG access, POBJECT_ATTRIBUTES object, PIO_STATUS_BLOCK io, ULONG share, ULONG disposition, ULONG options, ULONG type, ULONG read, ULONG completion, ULONG count, ULONG inQuota, ULONG outQuota, PLARGE_INTEGER timeout) {
    using Fn = NTSTATUS(NTAPI*)(PHANDLE,ULONG,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,ULONG,PLARGE_INTEGER);
    static auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateNamedPipeFile"));
    if (!selected_pipe(object) || disposition != FILE_CREATE || count != 1) return fn(handle,access,object,io,share,disposition,options,type,read,completion,count,inQuota,outQuota,timeout);
    IpcSecurity security(object->SecurityDescriptor);
    if (!security.ready) return static_cast<NTSTATUS>(0xc0000022L);
    auto copy = *object; copy.SecurityDescriptor = &security.descriptor;
    return fn(handle,access,&copy,io,share,disposition,options,type,read,completion,count,inQuota,outQuota,timeout);
}
extern "C" NTSTATUS NTAPI OpsNtCreateSection(PHANDLE handle, ULONG access, POBJECT_ATTRIBUTES object, PLARGE_INTEGER size, ULONG protect, ULONG attrs, HANDLE file) {
    using Fn = NTSTATUS(NTAPI*)(PHANDLE,ULONG,POBJECT_ATTRIBUTES,PLARGE_INTEGER,ULONG,ULONG,HANDLE);
    static auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateSection"));
    if (!selected_section(object,file)) return fn(handle,access,object,size,protect,attrs,file);
    IpcSecurity security(object->SecurityDescriptor);
    if (!security.ready) return static_cast<NTSTATUS>(0xc0000022L);
    auto copy = *object; copy.SecurityDescriptor = &security.descriptor;
    return fn(handle,access,&copy,size,protect,attrs,file);
}
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
