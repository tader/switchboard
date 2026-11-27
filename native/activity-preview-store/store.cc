// Windows-only Node-API adapter. No path-based I/O after opening a file.
#include <node_api.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <memory>
#include <stdexcept>
#include <cstring>
#include <cwctype>

struct Failure : std::runtime_error {
  DWORD code;
  Failure(const char* message, DWORD value = ERROR_ACCESS_DENIED) : std::runtime_error(message), code(value) {}
};
void check(BOOL ok, const char* message) { if (!ok) throw Failure(message, GetLastError()); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Local { void* value = nullptr; ~Local() { if (value) LocalFree(value); } };
struct Security {
  std::vector<char> tokenUser;
  BYTE system[SECURITY_MAX_SID_SIZE];
  Local descriptor;
  SECURITY_ATTRIBUTES attributes{};
  PSID user() { return reinterpret_cast<TOKEN_USER*>(tokenUser.data())->User.Sid; }
  Security() {
    HANDLE raw;
    check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "Cannot query preview owner");
    Handle token(raw); DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); tokenUser.resize(size);
    check(GetTokenInformation(token.value, TokenUser, tokenUser.data(), size, &size), "Cannot query preview owner");
    size = sizeof(system); check(CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &size), "Cannot create system SID");
    Local text; check(ConvertSidToStringSidW(user(), reinterpret_cast<LPWSTR*>(&text.value)), "Cannot encode owner");
    std::wstring sid = static_cast<wchar_t*>(text.value);
    // Same policy as the desktop app: owner + SYSTEM, protected DACL, inherited by children.
    auto sddl = L"O:" + sid + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
      reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value), nullptr), "Cannot create preview ACL");
    attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor.value, FALSE};
  }
  void verify(HANDLE h, bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};
    check(GetFileInformationByHandle(h, &info), "Cannot inspect preview object");
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory || (!directory && info.nNumberOfLinks != 1))
      throw Failure("Preview object type or identity is unsafe");
    PSID owner; PACL acl; Local sd;
    auto result = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value));
    if (result != ERROR_SUCCESS) throw Failure("Cannot inspect preview ACL", result);
    SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
    check(GetSecurityDescriptorControl(sd.value, &control, &revision), "Cannot inspect preview protection");
    if (!EqualSid(owner, user()) || !acl || acl->AceCount != 2 || (directory && !(control & SE_DACL_PROTECTED)))
      throw Failure("Preview owner or DACL is unsafe");
    bool ownerRule = false, systemRule = false;
    for (DWORD i = 0; i < acl->AceCount; ++i) {
      ACCESS_ALLOWED_ACE* ace;
      check(GetAce(acl, i, reinterpret_cast<void**>(&ace)), "Cannot inspect preview ACE");
      auto flags = ace->Header.AceFlags;
      if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Mask != FILE_ALL_ACCESS ||
          (flags & (INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE)) ||
          (directory && (flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)))
        throw Failure("Preview permissions are unsafe");
      if (EqualSid(&ace->SidStart, user()) && !ownerRule) ownerRule = true;
      else if (EqualSid(&ace->SidStart, system) && !systemRule) systemRule = true;
      else throw Failure("Unexpected preview principal");
    }
    if (!ownerRule || !systemRule) throw Failure("Missing preview permissions");
  }
};
struct Store {
  Security security;
  std::wstring path;
  std::vector<std::unique_ptr<Handle>> parents;
  bool closed = false;
  Store(std::wstring root, bool create) : path(root) {
    // Only normal absolute drive paths; reject UNC, device paths, ADS and ambiguous names.
    if (root.size() < 4 || root[1] != L':' || root[2] != L'\\' || !iswalpha(root[0]) || root.find(L'/', 0) != std::wstring::npos)
      throw Failure("Local absolute preview path required");
    wchar_t full[32768]; DWORD length = GetFullPathNameW(root.c_str(), 32768, full, nullptr);
    if (!length || length >= 32768 || _wcsicmp(full, root.c_str()) != 0) throw Failure("Canonical preview path required");
    if (GetDriveTypeW(root.substr(0, 3).c_str()) != DRIVE_FIXED) throw Failure("Local NTFS preview storage required");
    for (size_t end = 3;;) {
      bool last = end == root.size(); auto component = root.substr(0, end);
      if (end > 3) {
        auto part = component.substr(component.find_last_of(L'\\') + 1);
        if (part.empty() || part.back() == L'.' || part.back() == L' ' || part.find_first_of(L":*?<>|\"") != std::wstring::npos)
          throw Failure("Unsafe preview path component");
      }
      // No FILE_SHARE_DELETE: every ancestor stays pinned until the operation ends.
      auto h = CreateFileW(component.c_str(), FILE_READ_ATTRIBUTES | (last ? READ_CONTROL | FILE_LIST_DIRECTORY : 0),
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (h == INVALID_HANDLE_VALUE && last && create && GetLastError() == ERROR_FILE_NOT_FOUND) {
        check(CreateDirectoryW(component.c_str(), &security.attributes), "Cannot create private preview root");
        h = CreateFileW(component.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL | FILE_LIST_DIRECTORY,
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      }
      if (h == INVALID_HANDLE_VALUE) throw Failure("Cannot open preview directory", GetLastError());
      parents.push_back(std::make_unique<Handle>(h));
      BY_HANDLE_FILE_INFORMATION info{}; check(GetFileInformationByHandle(h, &info), "Cannot inspect preview path");
      if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
        throw Failure("Preview path contains a reparse point");
      if (last) {
        wchar_t format[32]; check(GetVolumeInformationByHandleW(h, nullptr, 0, nullptr, nullptr, nullptr, format, 32), "Cannot verify preview filesystem");
        if (wcscmp(format, L"NTFS") != 0) throw Failure("Local NTFS preview storage required");
        security.verify(h, true); break;
      }
      auto next = root.find(L'\\', end == 3 ? 3 : end + 1);
      end = next == std::wstring::npos ? root.size() : next;
    }
  }
  std::wstring file(const std::wstring& name) {
    if (closed) throw Failure("Preview store handle is closed");
    if (name.empty() || name == L"." || name == L".." || name.back() == L'.' || name.back() == L' ' ||
        name.find_first_of(L"\\/:*?<>|\"") != std::wstring::npos) throw Failure("Unsafe preview file name");
    return path + L"\\" + name;
  }
  std::unique_ptr<Handle> open(const std::wstring& name, DWORD access, bool create = false) {
    auto location = file(name);
    auto h = CreateFileW(location.c_str(), access | READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ, create ? &security.attributes : nullptr, create ? CREATE_NEW : OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (create ? FILE_FLAG_WRITE_THROUGH : 0), nullptr);
    if (h == INVALID_HANDLE_VALUE) throw Failure("Cannot open preview file", GetLastError());
    auto result = std::make_unique<Handle>(h); security.verify(h, false); return result;
  }
  void remove(const std::wstring& name) {
    try {
      auto h = open(name, DELETE); FILE_DISPOSITION_INFO disposition{TRUE};
      check(SetFileInformationByHandle(h->value, FileDispositionInfo, &disposition, sizeof(disposition)), "Cannot retire preview file");
    } catch (const Failure& e) { if (e.code != ERROR_FILE_NOT_FOUND) throw; }
  }
};

void napiCheck(napi_status status) { if (status != napi_ok) throw Failure("Invalid preview adapter arguments"); }
std::wstring string(napi_env env, napi_value value) {
  size_t n; napiCheck(napi_get_value_string_utf16(env, value, nullptr, 0, &n));
  std::u16string result(n + 1, 0); napiCheck(napi_get_value_string_utf16(env, value, result.data(), n + 1, &n));
  if (result.find(u'\0') != n) throw Failure("Invalid preview string");
  return std::wstring(reinterpret_cast<wchar_t*>(result.data()), n);
}
napi_value undefined(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
template<class F> napi_value call(napi_env env, F f) {
  try { return f(); } catch (const Failure& e) {
    napi_throw_error(env, e.code == ERROR_FILE_NOT_FOUND ? "ENOENT" : "EPREVIEW", e.what());
  } catch (const std::exception&) { napi_throw_error(env, "EPREVIEW", "Preview adapter failed"); }
  return nullptr;
}
std::vector<napi_value> args(napi_env env, napi_callback_info info, size_t count) {
  std::vector<napi_value> values(count); size_t actual = count;
  napiCheck(napi_get_cb_info(env, info, &actual, values.data(), nullptr, nullptr));
  if (actual != count) throw Failure("Invalid preview argument count"); return values;
}
Store* store(napi_env env, napi_value value) {
  void* ptr; napiCheck(napi_get_value_external(env, value, &ptr));
  auto s = static_cast<Store*>(ptr); if (s->closed) throw Failure("Preview store handle is closed");
  s->security.verify(s->parents.back()->value, true); return s;
}
napi_value Open(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 2); bool create; napiCheck(napi_get_value_bool(env, a[1], &create));
  auto s = std::make_unique<Store>(string(env, a[0]), create); napi_value value;
  napiCheck(napi_create_external(env, s.get(), [](napi_env, void* data, void*) { delete static_cast<Store*>(data); }, nullptr, &value));
  s.release(); return value;
}); }
napi_value Close(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 1); void* ptr; napiCheck(napi_get_value_external(env, a[0], &ptr));
  auto s = static_cast<Store*>(ptr); s->closed = true; s->parents.clear(); return undefined(env);
}); }
napi_value Read(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 3); auto s = store(env, a[0]); uint32_t limit; napiCheck(napi_get_value_uint32(env, a[2], &limit));
  auto h = s->open(string(env, a[1]), GENERIC_READ); LARGE_INTEGER size;
  check(GetFileSizeEx(h->value, &size), "Cannot inspect preview size");
  if (size.QuadPart < 0 || size.QuadPart > limit) throw Failure("Preview exceeds size limit");
  std::vector<char> bytes(static_cast<size_t>(size.QuadPart)); DWORD received;
  check(ReadFile(h->value, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr), "Cannot read preview");
  if (received != bytes.size()) throw Failure("Preview changed while reading");
  napi_value value; napiCheck(napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &value)); return value;
}); }
napi_value Remove(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 2); store(env, a[0])->remove(string(env, a[1])); return undefined(env);
}); }
void publish(Store* s, HANDLE handle, const std::wstring& target) {
  auto destination = s->file(target); DWORD size = static_cast<DWORD>(sizeof(FILE_RENAME_INFO) + destination.size() * sizeof(wchar_t));
  std::vector<char> buffer(size, 0); auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  rename->ReplaceIfExists = FALSE; rename->FileNameLength = static_cast<DWORD>(destination.size() * sizeof(wchar_t));
  memcpy(rename->FileName, destination.data(), rename->FileNameLength);
  check(SetFileInformationByHandle(handle, FileRenameInfo, rename, size), "Cannot publish preview");
  check(FlushFileBuffers(handle), "Cannot flush published preview");
}
napi_value Publish(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 3); auto s = store(env, a[0]);
  auto h = s->open(string(env, a[1]), GENERIC_READ | GENERIC_WRITE | DELETE);
  publish(s, h->value, string(env, a[2])); return undefined(env);
}); }
napi_value Write(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 5); auto s = store(env, a[0]); auto temp = string(env, a[1]), target = string(env, a[2]);
  bool replace; napiCheck(napi_get_value_bool(env, a[4], &replace));
  void* bytes; size_t length; napiCheck(napi_get_buffer_info(env, a[3], &bytes, &length));
  if (length > 65536 || temp == target) throw Failure("Invalid preview write");
  s->remove(temp); // Verify any interrupted temporary before removing it; never truncate a link.
  auto h = s->open(temp, GENERIC_WRITE | DELETE, true); DWORD written;
  check(WriteFile(h->value, bytes, static_cast<DWORD>(length), &written, nullptr), "Cannot write preview");
  if (written != length) throw Failure("Incomplete preview write");
  check(FlushFileBuffers(h->value), "Cannot flush preview");
  // Delete only an opened and verified destination. A crash in this gap fails closed.
  if (replace) s->remove(target);
  publish(s, h->value, target);
  return undefined(env);
}); }
napi_value List(napi_env env, napi_callback_info info) { return call(env, [&] {
  auto a = args(env, info, 1); auto s = store(env, a[0]); napi_value values; napiCheck(napi_create_array(env, &values)); uint32_t index = 0;
  alignas(FILE_ID_BOTH_DIR_INFO) char buffer[65536]; bool first = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(s->parents.back()->value, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer, sizeof(buffer))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      throw Failure("Cannot list preview store", GetLastError());
    }
    first = false; auto entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer);
    for (;;) {
      std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") { napi_value value; napiCheck(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(name.data()), name.size(), &value)); napiCheck(napi_set_element(env, values, index++, value)); }
      if (!entry->NextEntryOffset) break;
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<char*>(entry) + entry->NextEntryOffset);
    }
  }
  return values;
}); }
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"open",0,Open,0,0,0,napi_default,0}, {"close",0,Close,0,0,0,napi_default,0},
    {"read",0,Read,0,0,0,napi_default,0}, {"write",0,Write,0,0,0,napi_default,0},
    {"remove",0,Remove,0,0,0,napi_default,0}, {"list",0,List,0,0,0,napi_default,0}
    ,{"publish",0,Publish,0,0,0,napi_default,0}
  };
  napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
