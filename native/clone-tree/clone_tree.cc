// One clonefile(2) call for a whole tree. `cp -c -R` walks a tree and clones it one file at a
// time, which an endpoint security agent inspecting every file creation slows to a crawl; one
// call on the directory clones the hierarchy in the kernel instead.
//
// `clone(source, destination)` returns a promise. The call runs as Node-API async work on the
// libuv thread pool, never on the daemon's event loop, and it cannot be interrupted once it has
// started: the promise settles only after the syscall has returned, so nothing writes into the
// destination after it settles. A refusal rejects with an Error whose `errno` is the positive
// errno value. clonefile never falls back to a byte copy.

#include <node_api.h>
#include <sys/attr.h>
#include <sys/clonefile.h>

#include <cerrno>
#include <cstring>
#include <string>

namespace {

struct CloneWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string source;
  std::string destination;
  int error = 0;
};

bool ReadPath(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0) return false;
  std::string path(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, path.data(), path.size(), &copied) != napi_ok) return false;
  path.resize(copied);
  // An embedded NUL would silently name a different path.
  if (path.find('\0') != std::string::npos) return false;
  *out = std::move(path);
  return true;
}

void Execute(napi_env, void* data) {
  auto* work = static_cast<CloneWork*>(data);
  // CLONE_NOFOLLOW: a symlink is cloned as a symlink, as `cp -R` copies one by default.
  if (clonefile(work->source.c_str(), work->destination.c_str(), CLONE_NOFOLLOW) != 0) {
    work->error = errno;
  }
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<CloneWork*>(data);
  if (status == napi_ok && work->error == 0) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, work->deferred, undefined);
  } else {
    const int code = status == napi_ok ? work->error : 0;
    const std::string message = code != 0
        ? std::string("clonefile failed: ") + std::strerror(code)
        : std::string("clonefile work did not run");
    napi_value text;
    napi_value error;
    napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &text);
    napi_create_error(env, nullptr, text, &error);
    if (code != 0) {
      napi_value errno_value;
      napi_create_int32(env, code, &errno_value);
      napi_set_named_property(env, error, "errno", errno_value);
    }
    napi_reject_deferred(env, work->deferred, error);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value Clone(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    napi_throw_type_error(env, nullptr, "clone requires a source and a destination path");
    return nullptr;
  }
  auto* work = new CloneWork();
  if (!ReadPath(env, argv[0], &work->source) || !ReadPath(env, argv[1], &work->destination)) {
    delete work;
    napi_throw_type_error(env, nullptr, "clone paths must be non-empty strings without NUL");
    return nullptr;
  }
  napi_value promise;
  napi_value name;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "missionCloneTree", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, Execute, Complete, work, &work->work) != napi_ok) {
    delete work;
    napi_throw_error(env, nullptr, "clone could not schedule its work");
    return nullptr;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work);
    delete work;
    napi_throw_error(env, nullptr, "clone could not queue its work");
    return nullptr;
  }
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value clone;
  if (napi_create_function(env, "clone", NAPI_AUTO_LENGTH, Clone, nullptr, &clone) != napi_ok ||
      napi_set_named_property(env, exports, "clone", clone) != napi_ok) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
