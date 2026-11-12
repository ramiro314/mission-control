{
  "targets": [
    {
      "target_name": "clone_tree",
      "sources": ["<@(addon_sources)"],
      "defines": ["NAPI_VERSION=10"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0"
      }
    }
  ]
}
