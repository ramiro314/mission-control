{
  "targets": [
    {
      "target_name": "process_inspection",
      "sources": ["<@(addon_sources)"],
      "defines": ["NAPI_VERSION=10"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["advapi32.lib"]
          }
        ]
      ]
    }
  ]
}
