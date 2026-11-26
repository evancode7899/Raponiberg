import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { addPin, readPins, removePin, toPin } from "@/lib/pins";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The owner's saved views and pinned figures (lib/pins.ts): { pins }. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ pins: readPins() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the pins" }, { status: 500 });
  }
}

/** Body: { kind: "view", name, href } or { kind: "figure", name, descriptor }: saves it (one of the same name is replaced). */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ pins: addPin(toPin(await request.json().catch(() => null))) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save that" }, { status: 400 });
  }
}

/** ?kind=view|figure&name=…: takes it off. */
export async function DELETE(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = request.nextUrl.searchParams.get("kind");
  const name = request.nextUrl.searchParams.get("name") ?? "";
  if (kind !== "view" && kind !== "figure") return NextResponse.json({ error: "kind must be view or figure" }, { status: 400 });
  try {
    return NextResponse.json({ pins: removePin(kind, name) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't take it off" }, { status: 500 });
  }
}
