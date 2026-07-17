---
"sinscribe": patch
---

# 🔖 fix: add "Interactive chat" to the menu

Bare `sinscribe` opened the menu-driven dashboard, but the interactive chat
session was only reachable by running `sinscribe <message>` directly from the
shell — it had no entry in the menu itself. Added "Interactive chat" as the
first, always-available item; picking it exits the menu and launches the same
chat session (menu and chat use different Ink render modes — alt-screen vs.
not — so chat launches as its own render pass right after the menu's exits,
rather than being nested inside it).
