{
  "targets": [
    {
      "target_name": "state_lock",
      "sources": ["<@(addon_sources)"],
      "defines": ["NAPI_VERSION=10"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0"
      }
    }
  ]
}
