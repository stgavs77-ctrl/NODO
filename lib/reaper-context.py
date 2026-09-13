#!/usr/bin/env python3
"""Fixed-command, read-only REAPER MCP snapshot helper for NODO.

No stdin or command-line command selection is accepted. ReaperClient keeps its
own IPC mutex; this helper only calls the allowlisted getter commands below.
"""
import asyncio
import json

from reaper_mcp.reaper_client import ReaperClient

READ_COMMANDS = (
    "project_get_overview",
    "selection_get_selected_tracks",
    "selection_get_selected_items",
    "track_get_all",
    "transport_get_state",
    "fx_get_chain",
)
MAX_FX_TRACKS = 3


def payload(result):
    return result.get("data", result) if isinstance(result, dict) else {}


async def collect():
    client = ReaperClient()
    overview, selected_tracks, selected_items, tracks, transport = await asyncio.gather(
        client.execute("project_get_overview"),
        client.execute("selection_get_selected_tracks"),
        client.execute("selection_get_selected_items"),
        client.execute("track_get_all"),
        client.execute("transport_get_state"),
    )
    fx_chains = {}
    for track in payload(selected_tracks).get("tracks", [])[:MAX_FX_TRACKS]:
        index = track.get("index") if isinstance(track, dict) else None
        if isinstance(index, int) and index >= 0:
            fx_chains[str(index)] = await client.execute("fx_get_chain", track_index=index)
    return {"overview": overview, "selectedTracks": selected_tracks,
            "selectedItems": selected_items, "tracks": tracks,
            "transport": transport, "fxChains": fx_chains}


async def main():
    try:
        result = await asyncio.wait_for(collect(), timeout=5.5)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception:
        # The Node boundary deliberately exposes only one generic offline state.
        print(json.dumps({"error": "unavailable"}, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
