// The win32 process inspection addon: two reads Windows offers no documented interface for,
// which `src/server/process-inspection/win32.ts` needs to know which processes sit in a
// directory.
//
// `owners(pids)` answers, for each pid, whether the user this daemon runs as owns it: the
// process token's user SID compared with this process's own, which is the win32 stand-in for
// comparing a uid with `geteuid()`.
//
// `cwds(pids)` answers each pid's working directory, read out of the process's own memory:
// PEB -> RTL_USER_PROCESS_PARAMETERS -> CurrentDirectory.DosPath, the route psutil's
// `Process.cwd()` takes. Those structures are undocumented, so every read is checked against
// invariants the real structures always satisfy, and a read that does not satisfy them is a
// failure, never a path. The offsets used are:
//
//                                         64-bit   32-bit (WOW64)
//   PEB.ProcessParameters                  0x20     0x10   (documented in winternl.h)
//   RTL_USER_PROCESS_PARAMETERS.Flags      0x08     0x08
//   ...CurrentDirectory (CURDIR.DosPath)   0x38     0x24
//
// Neither function decides anything. Each reports, per pid, what it read or which step failed
// with which Win32 error, and the TypeScript caller owns the policy for each failure.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <winternl.h>
#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

static_assert(sizeof(void*) == 8, "the process inspection addon reads PEBs from a 64-bit process");

namespace {

using NtQueryInformationProcessFn = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);

// `ProcessWow64Information` is not in every SDK's PROCESSINFOCLASS.
constexpr PROCESSINFOCLASS kProcessWow64Information = static_cast<PROCESSINFOCLASS>(26);
// RTL_USER_PROC_PARAMS_NORMALIZED: the parameter block's string buffers are absolute addresses
// rather than offsets from the block. Every running process's block is normalized before its
// first instruction; one that is not is not a block we can read.
constexpr uint32_t kParamsNormalized = 0x01;
// The longest path Windows accepts anywhere, in UTF-16 code units.
constexpr uint32_t kMaxPathUnits = 32767;
// How many times a cwd read that changed underneath us is retried before it is reported.
constexpr int kStableReadAttempts = 3;

struct Layout {
  uint64_t params_in_peb;
  uint32_t pointer_size;
  uint64_t curdir_in_params;
};

constexpr Layout kLayout64 = {0x20, 8, 0x38};
constexpr Layout kLayout32 = {0x10, 4, 0x24};

// What one read produced: a value, or the step that failed and its Win32 error. A failed
// layout check reports ERROR_INVALID_DATA.
struct Failure {
  const char* step;
  DWORD code;
};

class Handle {
 public:
  explicit Handle(HANDLE handle) : handle_(handle) {}
  ~Handle() {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return handle_; }
  explicit operator bool() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }

 private:
  HANDLE handle_;
};

NtQueryInformationProcessFn QueryInformationProcess() {
  static const auto fn = reinterpret_cast<NtQueryInformationProcessFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  return fn;
}

bool ReadExact(HANDLE process, uint64_t address, void* out, size_t size, Failure* failure) {
  SIZE_T read = 0;
  if (!ReadProcessMemory(process, reinterpret_cast<LPCVOID>(address), out, size, &read)) {
    *failure = {"ReadProcessMemory", GetLastError()};
    return false;
  }
  if (read != size) {
    *failure = {"ReadProcessMemory", ERROR_PARTIAL_COPY};
    return false;
  }
  return true;
}

bool ReadPointer(HANDLE process, uint64_t address, uint32_t size, uint64_t* out, Failure* failure) {
  if (size == 8) return ReadExact(process, address, out, 8, failure);
  uint32_t narrow = 0;
  if (!ReadExact(process, address, &narrow, 4, failure)) return false;
  *out = narrow;
  return true;
}

// A UNICODE_STRING as the target lays it out: two USHORT lengths, then the buffer pointer
// aligned to the pointer size.
struct RemoteString {
  uint16_t length;
  uint16_t maximum;
  uint64_t buffer;
};

bool ReadRemoteString(HANDLE process, uint64_t address, const Layout& layout, RemoteString* out,
                      Failure* failure) {
  uint16_t lengths[2] = {0, 0};
  if (!ReadExact(process, address, lengths, sizeof(lengths), failure)) return false;
  out->length = lengths[0];
  out->maximum = lengths[1];
  return ReadPointer(process, address + layout.pointer_size, layout.pointer_size, &out->buffer, failure);
}

bool InvalidLayout(Failure* failure) {
  *failure = {"layout", ERROR_INVALID_DATA};
  return false;
}

// Where the target's process parameters live, and in which layout.
bool LocateParameters(HANDLE process, uint64_t* params, const Layout** layout, Failure* failure) {
  const auto query = QueryInformationProcess();
  if (query == nullptr) {
    *failure = {"GetProcAddress", ERROR_PROC_NOT_FOUND};
    return false;
  }

  // A WOW64 target runs 32-bit code against its 32-bit PEB, and that PEB's parameters are the
  // ones SetCurrentDirectory updates. An x64 process emulated on ARM64 is not WOW64: it
  // answers 0 here and uses the 64-bit layout, as a native process does.
  ULONG_PTR peb32 = 0;
  NTSTATUS status = query(process, kProcessWow64Information, &peb32, sizeof(peb32), nullptr);
  if (status < 0) {
    *failure = {"NtQueryInformationProcess", static_cast<DWORD>(status)};
    return false;
  }

  uint64_t peb = 0;
  if (peb32 != 0) {
    peb = peb32;
    *layout = &kLayout32;
  } else {
    PROCESS_BASIC_INFORMATION basic = {};
    status = query(process, ProcessBasicInformation, &basic, sizeof(basic), nullptr);
    if (status < 0) {
      *failure = {"NtQueryInformationProcess", static_cast<DWORD>(status)};
      return false;
    }
    peb = reinterpret_cast<uint64_t>(basic.PebBaseAddress);
    *layout = &kLayout64;
  }
  if (peb == 0) return InvalidLayout(failure);

  if (!ReadPointer(process, peb + (*layout)->params_in_peb, (*layout)->pointer_size, params, failure)) {
    return false;
  }
  if (*params == 0) return InvalidLayout(failure);
  return true;
}

// One read of CurrentDirectory.DosPath, checked against what the real structure always holds.
bool ReadDosPath(HANDLE process, uint64_t params, const Layout& layout, RemoteString* path,
                 std::vector<char16_t>* text, Failure* failure) {
  uint32_t header[3] = {0, 0, 0};  // MaximumLength, Length, Flags
  if (!ReadExact(process, params, header, sizeof(header), failure)) return false;
  const uint32_t maximum = header[0];
  const uint32_t length = header[1];
  const uint32_t flags = header[2];
  // The block's own size must cover the CURDIR we are about to read, and it is never larger
  // than what was allocated for it. A block that is not normalized holds offsets, not addresses.
  // CURDIR is a UNICODE_STRING (two pointers wide, with padding) and then a HANDLE.
  const uint64_t curdir_end = layout.curdir_in_params + 3 * static_cast<uint64_t>(layout.pointer_size);
  if (length < curdir_end || maximum < length || (flags & kParamsNormalized) == 0) {
    return InvalidLayout(failure);
  }

  if (!ReadRemoteString(process, params + layout.curdir_in_params, layout, path, failure)) return false;
  if (path->length == 0 || path->length % 2 != 0 || path->maximum < path->length ||
      path->length / 2 > kMaxPathUnits || path->buffer == 0) {
    return InvalidLayout(failure);
  }

  text->assign(path->length / 2, 0);
  return ReadExact(process, path->buffer, text->data(), path->length, failure);
}

// Whether the process behind an open handle has already exited. Its handle outlives it while
// anyone holds one, but its address space and handle table, cwd included, are gone. A process
// that exited with code 259 (STILL_ACTIVE) reads as running, which only costs certainty.
bool Exited(HANDLE process) {
  DWORD code = 0;
  return GetExitCodeProcess(process, &code) && code != STILL_ACTIVE;
}

// One working-directory read, retried until two consecutive reads agree, so a cwd that
// changes while we read is never reported as half of one path and half of another.
bool ReadStableCwd(HANDLE process, std::u16string* cwd, Failure* failure) {
  uint64_t params = 0;
  const Layout* layout = nullptr;
  if (!LocateParameters(process, &params, &layout, failure)) return false;

  RemoteString previous = {};
  std::vector<char16_t> previous_text;
  if (!ReadDosPath(process, params, *layout, &previous, &previous_text, failure)) return false;
  for (int attempt = 0; attempt < kStableReadAttempts; ++attempt) {
    RemoteString current = {};
    std::vector<char16_t> current_text;
    if (!ReadDosPath(process, params, *layout, &current, &current_text, failure)) return false;
    if (current.length == previous.length && current.buffer == previous.buffer &&
        current_text == previous_text) {
      cwd->assign(current_text.begin(), current_text.end());
      return true;
    }
    previous = current;
    previous_text = std::move(current_text);
  }
  *failure = {"stable read", ERROR_INVALID_DATA};
  return false;
}

bool ReadCwd(DWORD pid, std::u16string* cwd, Failure* failure) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  if (!process) {
    *failure = {"OpenProcess", GetLastError()};
    return false;
  }
  if (ReadStableCwd(process.get(), cwd, failure)) return true;
  // A read that failed because the process exited mid-read says so, rather than surfacing as
  // the memory error its vanished address space produced.
  if (Exited(process.get())) *failure = {"exited", 0};
  return false;
}

bool ReadTokenUser(HANDLE token, std::vector<BYTE>* buffer, Failure* failure) {
  DWORD size = 0;
  if (GetTokenInformation(token, TokenUser, nullptr, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    *failure = {"GetTokenInformation", GetLastError()};
    return false;
  }
  buffer->assign(size, 0);
  if (!GetTokenInformation(token, TokenUser, buffer->data(), size, &size)) {
    *failure = {"GetTokenInformation", GetLastError()};
    return false;
  }
  return true;
}

bool ProcessUser(HANDLE process, std::vector<BYTE>* buffer, Failure* failure) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) {
    *failure = {"OpenProcessToken", GetLastError()};
    return false;
  }
  Handle token(raw);
  return ReadTokenUser(token.get(), buffer, failure);
}

PSID SidOf(std::vector<BYTE>& token_user) {
  return reinterpret_cast<TOKEN_USER*>(token_user.data())->User.Sid;
}

// ---- Node-API surface ----

napi_value Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

// The one argument both functions take: an array of pids, each a positive 32-bit integer.
bool ReadPids(napi_env env, napi_callback_info info, std::vector<DWORD>* pids) {
  size_t argc = 1;
  napi_value argv[1];
  bool is_array = false;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_is_array(env, argv[0], &is_array) != napi_ok || !is_array) {
    ThrowTypeError(env, "expected one array of pids");
    return false;
  }
  uint32_t count = 0;
  if (napi_get_array_length(env, argv[0], &count) != napi_ok) {
    ThrowTypeError(env, "expected one array of pids");
    return false;
  }
  pids->reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    napi_value element;
    double value = 0;
    if (napi_get_element(env, argv[0], i, &element) != napi_ok ||
        napi_get_value_double(env, element, &value) != napi_ok || !(value >= 1) ||
        value > 4294967295.0 || value != static_cast<double>(static_cast<DWORD>(value))) {
      ThrowTypeError(env, "every pid must be a positive 32-bit integer");
      return false;
    }
    pids->push_back(static_cast<DWORD>(value));
  }
  return true;
}

bool SetString(napi_env env, napi_value object, const char* key, const char* value) {
  napi_value string;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &string) == napi_ok &&
         napi_set_named_property(env, object, key, string) == napi_ok;
}

bool SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number;
  return napi_create_double(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, key, number) == napi_ok;
}

// `{ failed: step, code }`, the shape both functions use for a pid they could not read.
napi_value FailureObject(napi_env env, const Failure& failure) {
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok || !SetString(env, object, "failed", failure.step) ||
      !SetNumber(env, object, "code", static_cast<double>(failure.code))) {
    return nullptr;
  }
  return object;
}

napi_value Owners(napi_env env, napi_callback_info info) {
  std::vector<DWORD> pids;
  if (!ReadPids(env, info, &pids)) return nullptr;

  std::vector<BYTE> own;
  Failure own_failure = {};
  if (!ProcessUser(GetCurrentProcess(), &own, &own_failure)) {
    return Throw(env, std::string("could not read this process's own user: ") + own_failure.step +
                          " failed with code " + std::to_string(own_failure.code));
  }

  napi_value results;
  if (napi_create_array_with_length(env, pids.size(), &results) != napi_ok) return nullptr;
  for (size_t i = 0; i < pids.size(); ++i) {
    napi_value entry = nullptr;
    Failure failure = {};
    std::vector<BYTE> user;
    // Limited information is granted across integrity levels and is all OpenProcessToken
    // needs, so this open does not fail merely because the process is elevated.
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pids[i]));
    if (!process) {
      failure = {"OpenProcess", GetLastError()};
    } else if (Exited(process.get())) {
      failure = {"exited", 0};
    } else if (ProcessUser(process.get(), &user, &failure)) {
      napi_value same;
      if (napi_create_object(env, &entry) != napi_ok ||
          napi_get_boolean(env, EqualSid(SidOf(user), SidOf(own)) != FALSE, &same) != napi_ok ||
          napi_set_named_property(env, entry, "sameUser", same) != napi_ok) {
        return nullptr;
      }
    }
    if (entry == nullptr && (entry = FailureObject(env, failure)) == nullptr) return nullptr;
    if (napi_set_element(env, results, static_cast<uint32_t>(i), entry) != napi_ok) return nullptr;
  }
  return results;
}

napi_value Cwds(napi_env env, napi_callback_info info) {
  std::vector<DWORD> pids;
  if (!ReadPids(env, info, &pids)) return nullptr;

  napi_value results;
  if (napi_create_array_with_length(env, pids.size(), &results) != napi_ok) return nullptr;
  for (size_t i = 0; i < pids.size(); ++i) {
    napi_value entry = nullptr;
    std::u16string cwd;
    Failure failure = {};
    if (ReadCwd(pids[i], &cwd, &failure)) {
      napi_value path;
      if (napi_create_object(env, &entry) != napi_ok ||
          napi_create_string_utf16(env, cwd.data(), cwd.size(), &path) != napi_ok ||
          napi_set_named_property(env, entry, "cwd", path) != napi_ok) {
        return nullptr;
      }
    } else if ((entry = FailureObject(env, failure)) == nullptr) {
      return nullptr;
    }
    if (napi_set_element(env, results, static_cast<uint32_t>(i), entry) != napi_ok) return nullptr;
  }
  return results;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"owners", nullptr, Owners, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cwds", nullptr, Cwds, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native process inspection addon");
    return nullptr;
  }
  return exports;
}
