#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <node_api.h>

#include <new>
#include <string>
#include <vector>

// The win32 build of the state ownership addon. It exports the same five functions as
// state_lock.cc, and `acquire`/`release` keep its handle contract: one exclusive,
// non-blocking lock per state home, held by a tagged handle that releases on `release`, on
// garbage collection, or when the process dies, with the same error codes.

namespace {

const napi_type_tag kStateLockHandleTag = {
    0xbedfddbf2a0f416aULL,
    0x8207e506b26bb37eULL,
};

// LockFileEx is mandatory, not advisory like flock: while the region is locked, no other
// handle can read or write those bytes. Locking the owner metadata itself would stop a
// contender from reading who holds the state home, which is what its refusal message
// reports. So the lock covers one byte far past any metadata ever written, and the file's
// contents stay readable. SQLite places its Windows lock bytes at 1 GiB for the same reason.
constexpr DWORD kLockOffsetLow = 0x40000000;
constexpr DWORD kLockOffsetHigh = 0;
constexpr DWORD kLockLength = 1;

struct StateLockHandle {
  HANDLE file;
  bool active;
};

OVERLAPPED LockRange() {
  OVERLAPPED range = {};
  range.Offset = kLockOffsetLow;
  range.OffsetHigh = kLockOffsetHigh;
  return range;
}

napi_value Undefined(napi_env env) {
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowSystemError(napi_env env, const char* code, const std::string& message) {
  napi_value message_value;
  napi_value error;
  napi_value code_value;
  if (napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
      napi_create_error(env, nullptr, message_value, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_set_named_property(env, error, "code", code_value) != napi_ok) {
    napi_throw_error(env, nullptr, message.c_str());
    return nullptr;
  }
  napi_throw(env, error);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &copied) != napi_ok ||
      copied != length) {
    return false;
  }
  output->assign(bytes.data(), copied);
  return true;
}

bool Utf8ToWide(const std::string& input, std::wstring* output) {
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), nullptr, 0);
  if (length <= 0) return false;
  output->resize(static_cast<size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), &(*output)[0], length) == length;
}

// The system's text for a Win32 error, the counterpart of strerror(errno).
std::string SystemMessage(DWORD error) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  std::string message;
  if (length > 0 && buffer != nullptr) {
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, buffer, static_cast<int>(length), nullptr, 0,
                                          nullptr, nullptr);
    if (bytes > 0) {
      message.resize(static_cast<size_t>(bytes));
      WideCharToMultiByte(CP_UTF8, 0, buffer, static_cast<int>(length), &message[0], bytes,
                          nullptr, nullptr);
    }
  }
  if (buffer != nullptr) LocalFree(buffer);
  while (!message.empty() && (message.back() == '\n' || message.back() == '\r' ||
                              message.back() == ' ' || message.back() == '.')) {
    message.pop_back();
  }
  return message + " (Win32 error " + std::to_string(error) + ")";
}

bool Truncate(HANDLE file) {
  LARGE_INTEGER zero = {};
  return SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) && SetEndOfFile(file);
}

bool WriteAll(HANDLE file, const std::string& contents) {
  const char* cursor = contents.data();
  size_t remaining = contents.size();
  while (remaining > 0) {
    const DWORD chunk = remaining > MAXDWORD ? MAXDWORD : static_cast<DWORD>(remaining);
    DWORD written = 0;
    if (!WriteFile(file, cursor, chunk, &written, nullptr) || written == 0) return false;
    cursor += written;
    remaining -= written;
  }
  return true;
}

// Closing a handle releases its locks eventually, but Windows does not promise when, so a
// lock this process took is always unlocked explicitly first.
void UnlockAndClose(HANDLE file) {
  OVERLAPPED range = LockRange();
  UnlockFileEx(file, 0, kLockLength, 0, &range);
  CloseHandle(file);
}

void FinalizeStateLock(napi_env, void* data, void*) {
  auto* handle = static_cast<StateLockHandle*>(data);
  if (handle->active) {
    UnlockAndClose(handle->file);
    handle->active = false;
  }
  delete handle;
}

napi_value AcquireStateLock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    return ThrowTypeError(env, "acquire requires a lock path and owner metadata");
  }

  std::string path;
  std::string owner;
  std::wstring wide_path;
  if (!ReadString(env, argv[0], &path) || path.empty() || !Utf8ToWide(path, &wide_path)) {
    return ThrowTypeError(env, "acquire lock path must be a non-empty string");
  }
  if (!ReadString(env, argv[1], &owner) || owner.empty()) {
    return ThrowTypeError(env, "acquire owner metadata must be a non-empty string");
  }

  // Shared like a file Node opens, so a contender can open it to read the owner metadata. A
  // null security descriptor makes the handle non-inheritable, the O_CLOEXEC counterpart.
  const HANDLE file = CreateFileW(wide_path.c_str(), GENERIC_READ | GENERIC_WRITE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                  OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return ThrowSystemError(
        env,
        "ELOCKOPEN",
        std::string("could not open state ownership file: ") + SystemMessage(GetLastError()));
  }

  OVERLAPPED range = LockRange();
  if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, kLockLength, 0,
                  &range)) {
    const DWORD lock_error = GetLastError();
    CloseHandle(file);
    if (lock_error == ERROR_LOCK_VIOLATION) {
      return ThrowSystemError(env, "ELOCKED", "state ownership is held by another process");
    }
    return ThrowSystemError(
        env,
        "ELOCKACQUIRE",
        std::string("could not acquire state ownership: ") + SystemMessage(lock_error));
  }

  if (!Truncate(file) || !WriteAll(file, owner) || !FlushFileBuffers(file)) {
    const DWORD write_error = GetLastError();
    UnlockAndClose(file);
    return ThrowSystemError(
        env,
        "ELOCKWRITE",
        std::string("could not write state ownership metadata: ") + SystemMessage(write_error));
  }

  auto* handle = new (std::nothrow) StateLockHandle{file, true};
  if (handle == nullptr) {
    UnlockAndClose(file);
    return ThrowSystemError(env, "ELOCKHANDLE", "could not allocate state ownership handle");
  }

  napi_value wrapped;
  if (napi_create_object(env, &wrapped) != napi_ok ||
      napi_type_tag_object(env, wrapped, &kStateLockHandleTag) != napi_ok ||
      napi_wrap(env, wrapped, handle, FinalizeStateLock, nullptr, nullptr) != napi_ok) {
    FinalizeStateLock(env, handle, nullptr);
    return ThrowSystemError(env, "ELOCKHANDLE", "could not create state ownership handle");
  }
  return wrapped;
}

napi_value ReleaseStateLock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "release requires one state ownership handle");
  }

  bool tagged = false;
  if (napi_check_object_type_tag(env, argv[0], &kStateLockHandleTag, &tagged) != napi_ok || !tagged) {
    return ThrowTypeError(env, "release requires a native state ownership handle");
  }
  StateLockHandle* handle = nullptr;
  if (napi_unwrap(env, argv[0], reinterpret_cast<void**>(&handle)) != napi_ok || handle == nullptr) {
    return ThrowTypeError(env, "release requires a native state ownership handle");
  }
  if (!handle->active) return Undefined(env);

  if (!Truncate(handle->file) || !FlushFileBuffers(handle->file)) {
    return ThrowSystemError(
        env,
        "ELOCKRELEASE",
        std::string("could not clear state ownership metadata: ") + SystemMessage(GetLastError()));
  }
  OVERLAPPED range = LockRange();
  if (!UnlockFileEx(handle->file, 0, kLockLength, 0, &range) || !CloseHandle(handle->file)) {
    return ThrowSystemError(
        env,
        "ELOCKRELEASE",
        std::string("could not release state ownership: ") + SystemMessage(GetLastError()));
  }
  handle->active = false;
  return Undefined(env);
}

// The symlink publication exports serve only Pi's extension links, and Pi is unavailable on
// win32 (D10 in docs/plans/windows-support/plan.md). They are exported so the addon loads
// with its full shape, and refuse with a stated reason rather than half-emulating
// linkat or renameatx_np semantics that Windows has no atomic equivalent for.
napi_value UnsupportedPublication(napi_env env, napi_callback_info) {
  return ThrowSystemError(env, "ENOTSUP", "symlink publication is not supported on win32");
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"acquire", nullptr, AcquireStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseStateLock, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"linkSymlinkNoReplace", nullptr, UnsupportedPublication, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exchangePaths", nullptr, UnsupportedPublication, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"renameNoReplace", nullptr, UnsupportedPublication, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 5, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native state lock addon");
    return nullptr;
  }
  return exports;
}
