import * as nodePath from "node:path";
import { badRequest } from "./api-error.js";

type PathModule = Pick<typeof nodePath, "basename" | "isAbsolute" | "relative" | "resolve" | "sep">;

export type ChatAttachmentDirName = "chat-attachments" | "chat-room-attachments";

function isSinglePathSegment(value: string, pathModule: PathModule): boolean {
  return value !== ""
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    // Drive-relative names and NTFS alternate data streams; generated attachment names never contain ":".
    && !value.includes(":")
    && pathModule.basename(value) === value;
}

/**
 * Resolve `<root>/.fusion/<dirName>/<ownerId>/<filename>` for a chat session or room attachment.
 *
 * FNXC:ChatAttachments 2026-10-07-17:59:
 * Containment uses `path.relative` against the attachments root, so it holds for the host's separator; the old `${dir}/` prefix check could never match a Windows backslash path and refused every attachment read.
 * The owner id and filename must each be one path segment. The session routes never looked the session up, so a `..` id escaped the attachments root while the old check only compared against that escaped directory.
 */
export function resolveChatAttachmentPath(
  rootDir: string,
  dirName: ChatAttachmentDirName,
  ownerId: string,
  filename: string,
  pathModule: PathModule = nodePath,
): { ownerDir: string; filePath: string } {
  if (!isSinglePathSegment(ownerId, pathModule) || !isSinglePathSegment(filename, pathModule)) {
    throw badRequest("Invalid attachment path");
  }
  const attachmentsRoot = pathModule.resolve(rootDir, ".fusion", dirName);
  const ownerDir = pathModule.resolve(attachmentsRoot, ownerId);
  const filePath = pathModule.resolve(ownerDir, filename);
  const relativePath = pathModule.relative(attachmentsRoot, filePath);
  const segments = relativePath.split(pathModule.sep);
  if (pathModule.isAbsolute(relativePath) || segments.length !== 2 || segments.some((segment) => segment === "" || segment === "..")) {
    throw badRequest("Invalid attachment path");
  }
  return { ownerDir, filePath };
}
