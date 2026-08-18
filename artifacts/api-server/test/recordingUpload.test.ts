import { test } from "node:test";
import assert from "node:assert/strict";
import { inferAudioMime, isUnsupportedAudioError, whisperFilename, partitionRecordingFiles, MAX_BULK_RECORDINGS, MAX_RECORDING_BYTES } from "../src/lib/audioUpload";
import {
  TELECALLER_RECORDING_PROMPT,
  buildTelecallerFallbackItem,
  formatBulkRecordingUploadToast,
  formatRecordingUploadToast,
  parseLearnOpts,
  shouldInsertTelecallerFallback,
} from "../src/lib/learningExtract";

test("inferAudioMime accepts Windows octet-stream by extension", () => {
  assert.equal(inferAudioMime("call.mp3", "application/octet-stream"), "audio/mpeg");
  assert.equal(inferAudioMime("desk-rec.M4A", "application/octet-stream"), "audio/mp4");
  assert.equal(inferAudioMime("line.wav", "application/download"), "audio/wav");
  assert.equal(inferAudioMime("ok.mp3", "audio/mpeg"), "audio/mpeg");
  assert.equal(inferAudioMime("notes.txt", "application/octet-stream"), null);
  assert.equal(inferAudioMime("call.mp3", "audio/mpeg; codecs=mp3"), "audio/mpeg");
});

test("whisperFilename adds an extension when the browser omitted one", () => {
  assert.equal(whisperFilename("clip.mp3", "audio/mpeg"), "clip.mp3");
  assert.equal(whisperFilename("recording", "audio/mp4"), "recording.m4a");
});

test("unsupported whisper errors become a convert-to-mp3 message", () => {
  assert.equal(isUnsupportedAudioError("Invalid file format"), true);
  assert.equal(isUnsupportedAudioError("rate limit"), false);
});

test("telecaller fallback fires only on empty extract of a real transcript", () => {
  assert.equal(shouldInsertTelecallerFallback(0, "x".repeat(80)), true);
  assert.equal(shouldInsertTelecallerFallback(3, "x".repeat(80)), false);
  assert.equal(shouldInsertTelecallerFallback(0, "too short"), false);
});

test("telecaller fallback never invents a rupee discount", () => {
  const item = buildTelecallerFallbackItem(
    "upload:Priyanka-xtreme.mp3",
    "Customer: dusra dealer 4000 cash de raha hai. Agent: aap showroom aa jaiye test ride ke liye.",
  );
  assert.match(item.title, /Priyanka-xtreme/);
  assert.match(item.content, /TRANSFER/);
  assert.doesNotMatch(item.content, /₹\s*4,?000|hum bhi/i);
  assert.equal(item.category, "playbook");
});

test("parseLearnOpts keeps live-call callers as post_call_audit", () => {
  assert.deepEqual(parseLearnOpts("CA123"), { source: "CA123", mode: "post_call_audit" });
  assert.equal(parseLearnOpts({ source: "upload:a.mp3", mode: "telecaller_recording", forceReview: true }).mode, "telecaller_recording");
});

test("telecaller prompt extracts skills and forbids empty + invented cash", () => {
  assert.match(TELECALLER_RECORDING_PROMPT, /NEVER return \{\"items\": \[\]\}/);
  assert.match(TELECALLER_RECORDING_PROMPT, /TRANSFER.*Priyanka/);
  assert.match(TELECALLER_RECORDING_PROMPT, /Devanagari/);
  assert.doesNotMatch(TELECALLER_RECORDING_PROMPT, /Empty is GOOD/);
});

test("upload toast reports inserted/queued, not a fake 0-success", () => {
  assert.equal(
    formatRecordingUploadToast({ itemsInserted: 4, itemsQueuedForReview: 4 }).kind,
    "success",
  );
  assert.match(
    formatRecordingUploadToast({ itemsInserted: 4, itemsQueuedForReview: 4 }).message,
    /Learned 4/,
  );
  assert.equal(
    formatRecordingUploadToast({ itemsInserted: 0, itemsQueuedForReview: 0, itemsSkipped: 2 }).kind,
    "warning",
  );
  assert.equal(
    formatRecordingUploadToast({ itemsInserted: 0, itemsQueuedForReview: 0, transcriptChars: 900 }).kind,
    "warning",
  );
  assert.match(
    formatRecordingUploadToast({ itemsInserted: 0, itemsQueuedForReview: 0, transcriptChars: 900 }).message,
    /0 skills/,
  );
});

test("partitionRecordingFiles accepts a folder of mp3s and rejects a zip", () => {
  const zip = partitionRecordingFiles([{ name: "New folder.zip", size: 80_000_000 }]);
  assert.equal(zip.zipRejected, true);
  assert.equal(zip.accepted.length, 0);

  const mixed = partitionRecordingFiles([
    { name: "a.mp3", size: 1_000_000 },
    { name: "b.m4a", size: 2_000_000 },
    { name: "huge.mp3", size: MAX_RECORDING_BYTES + 1 },
    { name: "notes.zip", size: 100 },
  ]);
  assert.equal(mixed.zipRejected, false);
  assert.deepEqual(mixed.accepted.map((f) => f.name), ["a.mp3", "b.m4a"]);
  assert.deepEqual(mixed.skippedLarge, ["huge.mp3"]);

  const many = Array.from({ length: MAX_BULK_RECORDINGS + 5 }, (_, i) => ({ name: `c${i}.mp3`, size: 1000 }));
  const capped = partitionRecordingFiles(many);
  assert.equal(capped.accepted.length, MAX_BULK_RECORDINGS);
  assert.equal(capped.truncated, 5);
});

test("bulk upload toast summarises many files", () => {
  assert.equal(
    formatBulkRecordingUploadToast({ filesOk: 12, filesFailed: 0, filesTotal: 12, itemsInserted: 30, itemsQueuedForReview: 30 }).kind,
    "success",
  );
  assert.match(
    formatBulkRecordingUploadToast({ filesOk: 12, filesFailed: 0, filesTotal: 12, itemsInserted: 30, itemsQueuedForReview: 30 }).message,
    /Approve all/,
  );
  assert.equal(
    formatBulkRecordingUploadToast({ filesOk: 0, filesFailed: 3, filesTotal: 3, itemsInserted: 0, itemsQueuedForReview: 0 }).kind,
    "error",
  );
  assert.equal(
    formatBulkRecordingUploadToast({ filesOk: 10, filesFailed: 2, filesTotal: 12, itemsInserted: 8, itemsQueuedForReview: 8 }).kind,
    "warning",
  );
});
