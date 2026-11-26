"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Statement PDFs dropped anywhere in the app go to Statements › Import, into its list of files
 * to import (they aren't imported until Import is pressed there). The import page's own drop
 * zone takes its drops itself; everywhere else, a file dragged over the window shows where it
 * will go.
 */
export const FILES_DROPPED_EVENT = "pf:files-dropped";
let held: File[] = [];

/** The files dropped elsewhere since the import page last looked, taken off the pile. */
export function takeDroppedFiles(): File[] {
  const out = held;
  held = [];
  return out;
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

/** Which dropped files the import page can take: PDFs only. */
export const pdfsOf = (files: Iterable<File>) => [...files].filter((f) => f.name.toLowerCase().endsWith(".pdf"));

export function DropAnywhere() {
  const router = useRouter();
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    // Without this the browser opens a file dropped outside a drop zone in place of the app.
    const overWindow = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      // The import page's own drop zone has taken it.
      if ((e.target as Element | null)?.closest?.("[data-drop-zone]")) return;
      const pdfs = pdfsOf(e.dataTransfer?.files ?? []);
      if (!pdfs.length) return;
      held = [...held, ...pdfs];
      window.dispatchEvent(new Event(FILES_DROPPED_EVENT));
      if (!(window.location.pathname === "/statements" && new URLSearchParams(window.location.search).get("tab") === "import")) router.push("/statements?tab=import");
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overWindow);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overWindow);
      window.removeEventListener("drop", drop);
    };
  }, [router]);
  if (!over) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[350] flex items-center justify-center bg-black/40">
      <div className="rounded-md border-2 border-dashed border-accent bg-surface-2 px-6 py-4 text-sm font-medium text-fg shadow-2xl">Drop statement PDFs to import them</div>
    </div>
  );
}
