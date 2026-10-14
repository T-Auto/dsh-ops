#include "security.h"
#include <string>
// Proxy only CreateNamedPipeA/CreatePipe imports of the private MSYS DLL.
extern "C" HANDLE WINAPI OpsCreateNamedPipeA(LPCSTR name, DWORD open, DWORD mode, DWORD instances, DWORD outSize, DWORD inSize, DWORD timeout, LPSECURITY_ATTRIBUTES original) {
    const std::string prefix = "\\\\.\\pipe\\msys-";
    std::string value = name ? name : "";
    std::string pid = "-" + std::to_string(GetCurrentProcessId()) + "-sigwait";
    const std::string key = value.size() >= prefix.size() + 16 ? value.substr(prefix.size(), 16) : "";
    bool selected = value.starts_with(prefix) && value.substr(prefix.size() + key.size()) == pid &&
        hex_key(std::wstring(key.begin(), key.end())) && instances == 1 && (open & FILE_FLAG_FIRST_PIPE_INSTANCE) && (mode & PIPE_REJECT_REMOTE_CLIENTS);
    if (!selected) return CreateNamedPipeA(name, open, mode, instances, outSize, inSize, timeout, original);
    IpcSecurity security(original ? original->lpSecurityDescriptor : nullptr);
    if (!security.ready) { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
    SECURITY_ATTRIBUTES attrs{sizeof(attrs), &security.descriptor, original ? original->bInheritHandle : FALSE};
    HANDLE result = CreateNamedPipeA(name, open, mode, instances, outSize, inSize, timeout, &attrs);
    DWORD error = GetLastError(); SetLastError(error); return result;
}
extern "C" BOOL WINAPI OpsCreatePipe(PHANDLE read, PHANDLE write, LPSECURITY_ATTRIBUTES original, DWORD size) {
    IpcSecurity security(original ? original->lpSecurityDescriptor : nullptr);
    if (!security.ready) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    SECURITY_ATTRIBUTES attrs{sizeof(attrs), &security.descriptor, original ? original->bInheritHandle : FALSE};
    return CreatePipe(read, write, &attrs, size);
}
// Windows SDK treats these API names specially in .def forwarders.
extern "C" int WINAPI OpsIdnToAscii(DWORD flags, LPCWSTR src, int len, LPWSTR dest, int cap) { return IdnToAscii(flags, src, len, dest, cap); }
extern "C" int WINAPI OpsIdnToUnicode(DWORD flags, LPCWSTR src, int len, LPWSTR dest, int cap) { return IdnToUnicode(flags, src, len, dest, cap); }
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
