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
//
// `readCwdFromImages(images, base, peb, wow64)` is the daemon-unused third export: the same cwd
// parser over byte images of an address space instead of a live process, so a test can feed it
// the corrupt structures no live process would, and pin that each one fails rather than reads.

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
#include <map>
#include <mutex>
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

// The target's address space, as the cwd parser sees it. A live process is read through
// ReadProcessMemory; `readCwdFromImages` supplies byte images instead, so the layout checks
// below can be driven with corrupt structures that no live process would hand over.
class Memory {
 public:
  virtual ~Memory() = default;
  virtual bool Read(uint64_t address, void* out, size_t size, Failure* failure) = 0;
  // Called before each re-read of the cwd, so an image source can change between reads.
  virtual void NextPass() {}
};

class ProcessMemory : public Memory {
 public:
  explicit ProcessMemory(HANDLE process) : process_(process) {}
  bool Read(uint64_t address, void* out, size_t size, Failure* failure) override {
    SIZE_T read = 0;
    if (!ReadProcessMemory(process_, reinterpret_cast<LPCVOID>(address), out, size, &read)) {
      *failure = {"ReadProcessMemory", GetLastError()};
      return false;
    }
    if (read != size) {
      *failure = {"ReadProcessMemory", ERROR_PARTIAL_COPY};
      return false;
    }
    return true;
  }

 private:
  HANDLE process_;
};

// Byte images of one region of an address space starting at `base`, one image per read pass;
// the last image keeps answering once the passes run past it. A read outside the region fails
// the way ReadProcessMemory fails on memory that is not mapped.
class ImageMemory : public Memory {
 public:
  ImageMemory(std::vector<std::vector<uint8_t>> images, uint64_t base)
      : images_(std::move(images)), base_(base) {}
  bool Read(uint64_t address, void* out, size_t size, Failure* failure) override {
    const std::vector<uint8_t>& image = images_[pass_ < images_.size() ? pass_ : images_.size() - 1];
    const uint64_t end = base_ + image.size();
    if (address < base_ || address >= end) {
      *failure = {"ReadProcessMemory", ERROR_NOACCESS};
      return false;
    }
    if (size > end - address) {
      *failure = {"ReadProcessMemory", ERROR_PARTIAL_COPY};
      return false;
    }
    std::memcpy(out, image.data() + (address - base_), size);
    return true;
  }
  void NextPass() override { ++pass_; }

 private:
  std::vector<std::vector<uint8_t>> images_;
  uint64_t base_;
  size_t pass_ = 0;
};

bool ReadPointer(Memory& memory, uint64_t address, uint32_t size, uint64_t* out, Failure* failure) {
  if (size == 8) return memory.Read(address, out, 8, failure);
  uint32_t narrow = 0;
  if (!memory.Read(address, &narrow, 4, failure)) return false;
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

bool ReadRemoteString(Memory& memory, uint64_t address, const Layout& layout, RemoteString* out,
                      Failure* failure) {
  uint16_t lengths[2] = {0, 0};
  if (!memory.Read(address, lengths, sizeof(lengths), failure)) return false;
  out->length = lengths[0];
  out->maximum = lengths[1];
  return ReadPointer(memory, address + layout.pointer_size, layout.pointer_size, &out->buffer, failure);
}

bool InvalidLayout(Failure* failure) {
  *failure = {"layout", ERROR_INVALID_DATA};
  return false;
}

// Where a live target's PEB lives, and in which layout.
bool LocatePeb(HANDLE process, uint64_t* peb, const Layout** layout, Failure* failure) {
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
  if (peb32 != 0) {
    *peb = peb32;
    *layout = &kLayout32;
    return true;
  }

  PROCESS_BASIC_INFORMATION basic = {};
  status = query(process, ProcessBasicInformation, &basic, sizeof(basic), nullptr);
  if (status < 0) {
    *failure = {"NtQueryInformationProcess", static_cast<DWORD>(status)};
    return false;
  }
  *peb = reinterpret_cast<uint64_t>(basic.PebBaseAddress);
  *layout = &kLayout64;
  return true;
}

// One read of CurrentDirectory.DosPath, checked against what the real structure always holds.
bool ReadDosPath(Memory& memory, uint64_t params, const Layout& layout, RemoteString* path,
                 std::vector<char16_t>* text, Failure* failure) {
  uint32_t header[3] = {0, 0, 0};  // MaximumLength, Length, Flags
  if (!memory.Read(params, header, sizeof(header), failure)) return false;
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

  if (!ReadRemoteString(memory, params + layout.curdir_in_params, layout, path, failure)) return false;
  if (path->length == 0 || path->length % 2 != 0 || path->maximum < path->length ||
      path->length / 2 > kMaxPathUnits || path->buffer == 0) {
    return InvalidLayout(failure);
  }

  text->assign(path->length / 2, 0);
  return memory.Read(path->buffer, text->data(), path->length, failure);
}

// The working directory behind a PEB, read until two consecutive reads agree, so a cwd that
// changes while we read is never reported as half of one path and half of another.
bool ReadStableCwd(Memory& memory, uint64_t peb, const Layout& layout, std::u16string* cwd,
                   Failure* failure) {
  if (peb == 0) return InvalidLayout(failure);
  uint64_t params = 0;
  if (!ReadPointer(memory, peb + layout.params_in_peb, layout.pointer_size, &params, failure)) return false;
  if (params == 0) return InvalidLayout(failure);

  RemoteString previous = {};
  std::vector<char16_t> previous_text;
  if (!ReadDosPath(memory, params, layout, &previous, &previous_text, failure)) return false;
  for (int attempt = 0; attempt < kStableReadAttempts; ++attempt) {
    memory.NextPass();
    RemoteString current = {};
    std::vector<char16_t> current_text;
    if (!ReadDosPath(memory, params, layout, &current, &current_text, failure)) return false;
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

// Whether the process behind an open handle has already exited. Its handle outlives it while
// anyone holds one, but its address space and handle table, cwd included, are gone. A process
// that exited with code 259 (STILL_ACTIVE) reads as running, which only costs certainty.
bool Exited(HANDLE process) {
  DWORD code = 0;
  return GetExitCodeProcess(process, &code) && code != STILL_ACTIVE;
}

bool ReadCwd(DWORD pid, std::u16string* cwd, Failure* failure) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  if (!process) {
    *failure = {"OpenProcess", GetLastError()};
    return false;
  }
  uint64_t peb = 0;
  const Layout* layout = nullptr;
  ProcessMemory memory(process.get());
  const bool read = LocatePeb(process.get(), &peb, &layout, failure) &&
                    ReadStableCwd(memory, peb, *layout, cwd, failure);
  // An exited process holds no cwd, even while its memory still reads: termination is reported
  // before the address space is torn down, and that leftover is not where anything sits. Asked
  // after the read, so an exit during it is caught too, and a failed read that the exit caused
  // says so instead of surfacing as the memory error the vanishing address space produced.
  if (Exited(process.get())) {
    *failure = {"exited", 0};
    return false;
  }
  return read;
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

// The one argument `identity` and the job functions take: a pid, a positive 32-bit integer.
bool ReadOnePid(napi_env env, napi_callback_info info, DWORD* pid) {
  size_t argc = 1;
  napi_value argv[1];
  double value = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_double(env, argv[0], &value) != napi_ok || !(value >= 1) || value > 4294967295.0 ||
      value != static_cast<double>(static_cast<DWORD>(value))) {
    ThrowTypeError(env, "expected one pid, a positive 32-bit integer");
    return false;
  }
  *pid = static_cast<DWORD>(value);
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

// `{ cwd }` for a read that answered, `{ failed, code }` for one that did not.
napi_value CwdObject(napi_env env, bool read, const std::u16string& cwd, const Failure& failure) {
  if (!read) return FailureObject(env, failure);
  napi_value entry;
  napi_value path;
  if (napi_create_object(env, &entry) != napi_ok ||
      napi_create_string_utf16(env, cwd.data(), cwd.size(), &path) != napi_ok ||
      napi_set_named_property(env, entry, "cwd", path) != napi_ok) {
    return nullptr;
  }
  return entry;
}

napi_value Cwds(napi_env env, napi_callback_info info) {
  std::vector<DWORD> pids;
  if (!ReadPids(env, info, &pids)) return nullptr;

  napi_value results;
  if (napi_create_array_with_length(env, pids.size(), &results) != napi_ok) return nullptr;
  for (size_t i = 0; i < pids.size(); ++i) {
    std::u16string cwd;
    Failure failure = {};
    const bool read = ReadCwd(pids[i], &cwd, &failure);
    napi_value entry = CwdObject(env, read, cwd, failure);
    if (entry == nullptr || napi_set_element(env, results, static_cast<uint32_t>(i), entry) != napi_ok) {
      return nullptr;
    }
  }
  return results;
}

bool ReadAddress(napi_env env, napi_value value, uint64_t* out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) ||
      number > 9007199254740991.0 || number != static_cast<double>(static_cast<uint64_t>(number))) {
    return false;
  }
  *out = static_cast<uint64_t>(number);
  return true;
}

// `readCwdFromImages(images, base, peb, wow64)`: the parser `cwds` runs on a live process, run
// over byte images of an address space instead. `images` are successive snapshots of the region
// that starts at `base` (each re-read takes the next, the last one repeats), `peb` is the PEB's
// address in it, and `wow64` selects the 32-bit layout. It reads no process; it exists so the
// layout checks can be driven with structures no live process would hand over.
napi_value ReadCwdFromImages(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  bool is_array = false;
  uint32_t count = 0;
  uint64_t base = 0;
  uint64_t peb = 0;
  bool wow64 = false;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4 ||
      napi_is_array(env, argv[0], &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, argv[0], &count) != napi_ok || count == 0 ||
      !ReadAddress(env, argv[1], &base) || !ReadAddress(env, argv[2], &peb) ||
      napi_get_value_bool(env, argv[3], &wow64) != napi_ok) {
    return ThrowTypeError(env, "expected images, base, peb and wow64");
  }

  std::vector<std::vector<uint8_t>> images;
  for (uint32_t i = 0; i < count; ++i) {
    napi_value element;
    bool is_typed = false;
    napi_typedarray_type type;
    size_t length = 0;
    void* data = nullptr;
    if (napi_get_element(env, argv[0], i, &element) != napi_ok ||
        napi_is_typedarray(env, element, &is_typed) != napi_ok || !is_typed ||
        napi_get_typedarray_info(env, element, &type, &length, &data, nullptr, nullptr) != napi_ok ||
        type != napi_uint8_array) {
      return ThrowTypeError(env, "every image must be a Uint8Array");
    }
    const auto* bytes = static_cast<const uint8_t*>(data);
    images.emplace_back(bytes, bytes + length);
  }

  ImageMemory memory(std::move(images), base);
  std::u16string cwd;
  Failure failure = {};
  const bool read = ReadStableCwd(memory, peb, wow64 ? kLayout32 : kLayout64, &cwd, &failure);
  return CwdObject(env, read, cwd, failure);
}

// ---- start identity ----

// `ProcessCommandLineInformation`, Windows 8.1 and later: the command line as a UNICODE_STRING
// followed by its buffer, readable with limited information, so no PEB walk is needed.
constexpr PROCESSINFOCLASS kProcessCommandLineInformation = static_cast<PROCESSINFOCLASS>(60);
constexpr NTSTATUS kStatusInfoLengthMismatch = static_cast<NTSTATUS>(0xC0000004L);
constexpr NTSTATUS kStatusBufferTooSmall = static_cast<NTSTATUS>(0xC0000023L);
constexpr NTSTATUS kStatusBufferOverflow = static_cast<NTSTATUS>(0x80000005L);

bool ReadCommandLine(HANDLE process, std::u16string* command, Failure* failure) {
  const auto query = QueryInformationProcess();
  if (query == nullptr) {
    *failure = {"GetProcAddress", ERROR_PROC_NOT_FOUND};
    return false;
  }
  ULONG size = 0;
  NTSTATUS status = query(process, kProcessCommandLineInformation, nullptr, 0, &size);
  if (status != kStatusInfoLengthMismatch && status != kStatusBufferTooSmall && status != kStatusBufferOverflow) {
    *failure = {"NtQueryInformationProcess", static_cast<DWORD>(status)};
    return false;
  }
  if (size < sizeof(UNICODE_STRING)) return InvalidLayout(failure);
  // Aligned for the UNICODE_STRING at its head.
  std::vector<uint64_t> buffer((size + sizeof(uint64_t) - 1) / sizeof(uint64_t), 0);
  status = query(process, kProcessCommandLineInformation, buffer.data(), size, &size);
  if (status < 0) {
    *failure = {"NtQueryInformationProcess", static_cast<DWORD>(status)};
    return false;
  }
  const auto* text = reinterpret_cast<const UNICODE_STRING*>(buffer.data());
  const auto* begin = reinterpret_cast<const char*>(buffer.data());
  const auto* data = reinterpret_cast<const char*>(text->Buffer);
  // The buffer must lie inside what was returned, or this is not the structure we asked for.
  if (text->Length % 2 != 0 || (text->Length > 0 && (data < begin || data + text->Length > begin + size))) {
    return InvalidLayout(failure);
  }
  command->assign(reinterpret_cast<const char16_t*>(text->Buffer), text->Length / 2);
  return true;
}

// The creation time as 100-nanosecond ticks since 1601, in decimal: the full resolution
// Windows keeps, rather than the whole second a printed start time would round it to.
bool ReadCreationTicks(HANDLE process, std::string* ticks, Failure* failure) {
  FILETIME creation = {};
  FILETIME exit = {};
  FILETIME kernel = {};
  FILETIME user = {};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
    *failure = {"GetProcessTimes", GetLastError()};
    return false;
  }
  const uint64_t value = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  if (value == 0) return InvalidLayout(failure);
  *ticks = std::to_string(value);
  return true;
}

// `identity(pid)`: `{ start, command }` from one open of the process, or `{ failed, code }`. An
// exited process answers `exited`, so a handle that outlives its process never reads as alive.
napi_value Identity(napi_env env, napi_callback_info info) {
  DWORD pid = 0;
  if (!ReadOnePid(env, info, &pid)) return nullptr;
  Failure failure = {};
  std::string start;
  std::u16string command;
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  bool read = false;
  if (!process) {
    failure = {"OpenProcess", GetLastError()};
  } else {
    read = ReadCreationTicks(process.get(), &start, &failure) &&
           ReadCommandLine(process.get(), &command, &failure);
    if (Exited(process.get())) {
      failure = {"exited", 0};
      read = false;
    }
  }
  if (!read) return FailureObject(env, failure);
  napi_value entry;
  napi_value text;
  if (napi_create_object(env, &entry) != napi_ok || !SetString(env, entry, "start", start.c_str()) ||
      napi_create_string_utf16(env, command.data(), command.size(), &text) != napi_ok ||
      napi_set_named_property(env, entry, "command", text) != napi_ok) {
    return nullptr;
  }
  return entry;
}

// ---- check jobs ----
//
// A workflow Check's process group, which Windows does not have, is a job object here. The
// supervisor is assigned to a fresh job before it is allowed to start the check command, and
// everything that command starts is created inside the job, whatever its parent pid says later.
//
// The job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and its handle lives only in this
// process (unnamed, not inheritable). So the job can end in exactly two ways: this process
// terminates it, or this process goes away, and the kernel closes the handle and terminates
// every process still in it. A daemon that crashes therefore takes its checks with it, which is
// what lets the next daemon prove a recorded group empty without having a handle to it.
//
// Jobs are keyed by the supervisor's pid. One process can hold one live job per pid, which is
// the same rule a process group id obeys, and a pid reused while its old job still has members
// is refused rather than shared.

std::mutex& JobsLock() {
  static std::mutex lock;
  return lock;
}

std::map<DWORD, HANDLE>& Jobs() {
  static std::map<DWORD, HANDLE> jobs;
  return jobs;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  return napi_get_boolean(env, value, &result) == napi_ok ? result : nullptr;
}

// `jobAssign(pid)`: `true`, or `{ failed, code }` with nothing left behind.
napi_value JobAssign(napi_env env, napi_callback_info info) {
  DWORD pid = 0;
  if (!ReadOnePid(env, info, &pid)) return nullptr;
  std::lock_guard<std::mutex> guard(JobsLock());
  if (Jobs().count(pid) != 0) return FailureObject(env, {"existing job", ERROR_ALREADY_EXISTS});

  Handle process(OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process) return FailureObject(env, {"OpenProcess", GetLastError()});
  if (Exited(process.get())) return FailureObject(env, {"exited", 0});

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return FailureObject(env, {"CreateJobObject", GetLastError()});
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    const DWORD code = GetLastError();
    CloseHandle(job);
    return FailureObject(env, {"SetInformationJobObject", code});
  }
  if (!AssignProcessToJobObject(job, process.get())) {
    const DWORD code = GetLastError();
    CloseHandle(job);
    return FailureObject(env, {"AssignProcessToJobObject", code});
  }
  Jobs()[pid] = job;
  return Boolean(env, true);
}

// `jobActive(pid)`: how many processes the job still holds, or `null` when this process holds
// no job for that pid.
napi_value JobActive(napi_env env, napi_callback_info info) {
  DWORD pid = 0;
  if (!ReadOnePid(env, info, &pid)) return nullptr;
  std::lock_guard<std::mutex> guard(JobsLock());
  const auto found = Jobs().find(pid);
  napi_value result;
  if (found == Jobs().end()) return napi_get_null(env, &result) == napi_ok ? result : nullptr;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!QueryInformationJobObject(found->second, JobObjectBasicAccountingInformation, &accounting,
                                 sizeof(accounting), nullptr)) {
    return FailureObject(env, {"QueryInformationJobObject", GetLastError()});
  }
  return napi_create_double(env, static_cast<double>(accounting.ActiveProcesses), &result) == napi_ok ? result
                                                                                                       : nullptr;
}

// `jobTerminate(pid)`: `true` once every process in the job has been told to end, `false` when
// this process holds no job for that pid, or `{ failed, code }`.
napi_value JobTerminate(napi_env env, napi_callback_info info) {
  DWORD pid = 0;
  if (!ReadOnePid(env, info, &pid)) return nullptr;
  std::lock_guard<std::mutex> guard(JobsLock());
  const auto found = Jobs().find(pid);
  if (found == Jobs().end()) return Boolean(env, false);
  if (!TerminateJobObject(found->second, 1)) return FailureObject(env, {"TerminateJobObject", GetLastError()});
  return Boolean(env, true);
}

// `jobRelease(pid)`: close this process's handle to the job. Closing it terminates anything
// still inside, so the caller releases a job only once it has proven it empty.
napi_value JobRelease(napi_env env, napi_callback_info info) {
  DWORD pid = 0;
  if (!ReadOnePid(env, info, &pid)) return nullptr;
  std::lock_guard<std::mutex> guard(JobsLock());
  const auto found = Jobs().find(pid);
  if (found == Jobs().end()) return Boolean(env, false);
  CloseHandle(found->second);
  Jobs().erase(found);
  return Boolean(env, true);
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"owners", nullptr, Owners, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cwds", nullptr, Cwds, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readCwdFromImages", nullptr, ReadCwdFromImages, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"identity", nullptr, Identity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"jobAssign", nullptr, JobAssign, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"jobActive", nullptr, JobActive, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"jobTerminate", nullptr, JobTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"jobRelease", nullptr, JobRelease, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native process inspection addon");
    return nullptr;
  }
  return exports;
}
