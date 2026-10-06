// The win32 build of the Keep Awake addon: the same `create(reason)` / `release(handle)`
// contract as keep_awake.mm, backed by a Windows power request instead of an IOKit assertion.
//
// A power request rather than SetThreadExecutionState, for three reasons. It is a kernel
// handle, so each `create` maps onto one handle exactly as each IOKit assertion maps onto one
// assertion ID, with no per-thread flag to reference-count. It carries the reason string, so
// `powercfg /requests` names Mission Control the way `pmset -g assertions` does on macOS, which
// is what lets the verification probe find it. And the kernel closes it when the process exits,
// so a crash releases it just as IOKit drops a dead process's assertion.
//
// `PowerRequestSystemRequired` is the counterpart of `PreventUserIdleSystemSleep`: it prevents
// idle system sleep and nothing else, so the display still turns off and the session still locks.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <node_api.h>

#include <cstdint>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxReasonBytes = 128;
const napi_type_tag kAssertionHandleTag = {
    0x8a22c749e7a64353ULL,
    0xa46fe8e4988b502bULL,
};

struct AssertionHandle {
  HANDLE request;
  bool active;
};

napi_value Undefined(napi_env env) {
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

std::string Win32Failure(const char* operation, DWORD code) {
  return std::string("Windows power request ") + operation + " failed with code " +
         std::to_string(static_cast<uint32_t>(code));
}

void FinalizeAssertion(napi_env, void* data, void*) {
  auto* handle = static_cast<AssertionHandle*>(data);
  if (handle->active) {
    // Best effort, as in keep_awake.mm: a finalizer cannot report failure, and closing the
    // handle drops the request whether or not the clear succeeded.
    PowerClearRequest(handle->request, PowerRequestSystemRequired);
    CloseHandle(handle->request);
    handle->active = false;
  }
  delete handle;
}

napi_value CreateAssertion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "create requires one reason string");
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    return ThrowTypeError(env, "create reason must be a string");
  }

  size_t reason_length = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &reason_length) != napi_ok) {
    return ThrowTypeError(env, "create reason must be valid UTF-8");
  }
  if (reason_length == 0 || reason_length > kMaxReasonBytes) {
    napi_throw_range_error(env, nullptr, "create reason must be 1 to 128 UTF-8 bytes");
    return nullptr;
  }

  // The byte bound above is the contract both platforms share. Windows wants UTF-16, and
  // N-API hands that over directly; it is never longer than the UTF-8 it came from.
  std::vector<char16_t> reason(reason_length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, argv[0], reason.data(), reason.size(), &copied) != napi_ok ||
      copied == 0) {
    return ThrowTypeError(env, "create reason could not be read");
  }

  REASON_CONTEXT context = {};
  context.Version = POWER_REQUEST_CONTEXT_VERSION;
  context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
  context.Reason.SimpleReasonString = reinterpret_cast<LPWSTR>(reason.data());

  const HANDLE request = PowerCreateRequest(&context);
  if (request == INVALID_HANDLE_VALUE) {
    return ThrowError(env, Win32Failure("create", GetLastError()));
  }
  if (!PowerSetRequest(request, PowerRequestSystemRequired)) {
    const DWORD error = GetLastError();
    CloseHandle(request);
    return ThrowError(env, Win32Failure("set", error));
  }

  auto* handle = new (std::nothrow) AssertionHandle{request, true};
  if (handle == nullptr) {
    PowerClearRequest(request, PowerRequestSystemRequired);
    CloseHandle(request);
    return ThrowError(env, "native keep-awake handle allocation failed");
  }

  napi_value wrapped;
  if (napi_create_object(env, &wrapped) != napi_ok ||
      napi_type_tag_object(env, wrapped, &kAssertionHandleTag) != napi_ok ||
      napi_wrap(env, wrapped, handle, FinalizeAssertion, nullptr, nullptr) != napi_ok) {
    FinalizeAssertion(env, handle, nullptr);
    return ThrowError(env, "native keep-awake handle creation failed");
  }
  return wrapped;
}

napi_value ReleaseAssertion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowTypeError(env, "release requires one assertion handle");
  }

  bool tagged = false;
  if (napi_check_object_type_tag(env, argv[0], &kAssertionHandleTag, &tagged) != napi_ok || !tagged) {
    return ThrowTypeError(env, "release requires a native keep-awake handle");
  }

  AssertionHandle* handle = nullptr;
  if (napi_unwrap(env, argv[0], reinterpret_cast<void**>(&handle)) != napi_ok || handle == nullptr) {
    return ThrowTypeError(env, "release requires a native keep-awake handle");
  }
  if (!handle->active) return Undefined(env);

  // Closing the handle alone would also drop the request, but a failed clear must surface as
  // a retained handle the manager can retry, not be hidden behind a close.
  if (!PowerClearRequest(handle->request, PowerRequestSystemRequired)) {
    return ThrowError(env, Win32Failure("clear", GetLastError()));
  }
  CloseHandle(handle->request);
  handle->active = false;
  return Undefined(env);
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"create", nullptr, CreateAssertion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseAssertion, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "could not initialize native keep-awake addon");
    return nullptr;
  }
  return exports;
}
