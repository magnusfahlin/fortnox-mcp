import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fortnoxRequest,
  fortnoxRequestBinary,
  fortnoxUploadFile,
  type FortnoxBinaryResponse
} from "../services/api.js";
import { ResponseFormat } from "../constants.js";
import {
  getDownloadDir,
  sanitizeFilename,
  saveDownloadedFile
} from "../services/downloads.js";
import {
  buildToolResponse,
  buildErrorResponse
} from "../services/formatters.js";
import {
  ListInboxFilesSchema,
  GetInboxFileSchema,
  UploadInboxFileSchema,
  ConnectFileToVoucherSchema,
  MAX_INBOX_UPLOAD_BYTES,
  type ListInboxFilesInput,
  type GetInboxFileInput,
  type UploadInboxFileInput,
  type ConnectFileToVoucherInput
} from "../schemas/inbox.js";

// API response types
interface FortnoxFolderFileRow {
  Id: string;
  Name: string;
  Path?: string;
  Size?: number;
  ArchiveFileId?: string;
  Comments?: string;
  "@url"?: string;
}

interface FortnoxFolderFolderRow {
  Id: string;
  Name: string;
  "@url"?: string;
}

interface FortnoxFolder {
  Id?: string;
  Name?: string;
  Email?: string;
  Files?: FortnoxFolderFileRow[];
  Folders?: FortnoxFolderFolderRow[];
  "@url"?: string;
}

interface FolderResponse {
  Folder: FortnoxFolder;
}

interface FolderFileResponse {
  File: FortnoxFolderFileRow;
}

interface FortnoxVoucherFileConnection {
  FileId: string;
  VoucherNumber: string;
  VoucherSeries: string;
  VoucherYear?: number;
  VoucherDescription?: string;
  "@url"?: string;
}

interface VoucherFileConnectionResponse {
  VoucherFileConnection: FortnoxVoucherFileConnection;
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Save a downloaded Inbox file under the configured download directory and
 * return metadata (including the local path) instead of the file content.
 */
async function saveInboxFileToDisk(
  downloadDir: string,
  fileId: string,
  file: FortnoxBinaryResponse
) {
  const filename = sanitizeFilename(file.filename, `fortnox-inbox-${fileId}`);
  const saved = await saveDownloadedFile(downloadDir, filename, file.data);

  const output = {
    file_id: fileId,
    filename: file.filename || null,
    saved_filename: saved.filename,
    local_path: saved.path,
    content_type: file.contentType,
    size_bytes: file.data.length,
    save_status: saved.status
  };

  const statusNote =
    saved.status === "already_exists"
      ? "An identical file already existed and was reused."
      : saved.status === "saved_renamed"
        ? "A different file with the same name already existed, so a numbered name was used."
        : "Saved.";

  const textContent =
    `# Inbox File: ${file.filename || fileId}\n\n` +
    `**Saved to**: ${saved.path}\n` +
    `**Content-Type**: ${file.contentType}\n` +
    `**Size**: ${formatFileSize(file.data.length)}\n\n` +
    statusNote;

  return buildToolResponse(textContent, output);
}

/**
 * Register all Fortnox Inbox-related tools
 */
export function registerInboxTools(server: McpServer): void {
  // List inbox files/folders
  server.registerTool(
    "fortnox_list_inbox_files",
    {
      title: "List Fortnox Inbox Files",
      description: `List files and subfolders in the Fortnox Inbox.

The Inbox is Fortnox's staging area for documents (e.g. receipts, invoices)
before they are filed into the Archive or attached to a voucher.

Args:
  - folder_id (string): Inbox folder Id to list. Omit to list the Inbox root folder.
  - response_format ('markdown' | 'json'): Output format

Returns:
  Files (with Id, name, size) and subfolders (with Id, name) in the given folder.
  Use the file Id with fortnox_get_inbox_file to download, or with
  fortnox_connect_file_to_voucher to attach it to a voucher.`,
      inputSchema: ListInboxFilesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: ListInboxFilesInput) => {
      try {
        const endpoint = params.folder_id
          ? `/3/inbox/${encodeURIComponent(params.folder_id)}`
          : "/3/inbox";

        const response = await fortnoxRequest<FolderResponse>(endpoint);
        const folder = response.Folder;
        const files = folder.Files || [];
        const folders = folder.Folders || [];

        const output = {
          folder_id: folder.Id || params.folder_id || null,
          folder_name: folder.Name || null,
          files: files.map((f) => ({
            id: f.Id,
            name: f.Name,
            path: f.Path || null,
            size_bytes: f.Size ?? null,
            archive_file_id: f.ArchiveFileId || null
          })),
          folders: folders.map((fo) => ({
            id: fo.Id,
            name: fo.Name
          }))
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# Fortnox Inbox${folder.Name ? `: ${folder.Name}` : ""}`,
            ""
          ];

          if (folders.length > 0) {
            lines.push("## Folders", "");
            for (const fo of folders) {
              lines.push(`- 📁 **${fo.Name}** (id: \`${fo.Id}\`)`);
            }
            lines.push("");
          }

          if (files.length > 0) {
            lines.push("## Files", "");
            lines.push("| Name | Size | Id |");
            lines.push("|------|------|----|");
            for (const f of files) {
              lines.push(`| ${f.Name} | ${formatFileSize(f.Size)} | \`${f.Id}\` |`);
            }
          } else if (folders.length === 0) {
            lines.push("*This folder is empty.*");
          }

          textContent = lines.join("\n");
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );

  // Download a single inbox file
  server.registerTool(
    "fortnox_get_inbox_file",
    {
      title: "Download Fortnox Inbox File",
      description: `Download a single file from the Fortnox Inbox by its Id.

Use fortnox_list_inbox_files first to find the file Id.

Two modes, depending on server configuration:

1. FORTNOX_DOWNLOAD_DIR is set: the file is saved into that directory and the
   response contains the local file path (field "local_path"), the saved
   filename, MIME type and size - not the file content. An existing different
   file is never overwritten; a numbered name is used instead.

2. FORTNOX_DOWNLOAD_DIR is not set: File content is returned base64-encoded in
   the structured output (field "content_base64"). This inflates the payload by
   ~33% and consumes context/token budget - avoid for very large files. Files
   larger than ${Math.round(MAX_INBOX_UPLOAD_BYTES / (1024 * 1024))}MB are rejected rather than embedded inline.

The file in Fortnox is never modified or deleted.

Args:
  - file_id (string): Inbox file Id to download (required)

Returns:
  Mode 1: file Id, original and saved filename, local path, MIME type, size.
  Mode 2: the file's name, MIME type, size, and base64-encoded content.`,
      inputSchema: GetInboxFileSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: GetInboxFileInput) => {
      try {
        const file = await fortnoxRequestBinary(`/3/inbox/${encodeURIComponent(params.file_id)}`);

        const downloadDir = getDownloadDir();
        if (downloadDir) {
          return await saveInboxFileToDisk(downloadDir, params.file_id, file);
        }

        if (file.data.length > MAX_INBOX_UPLOAD_BYTES) {
          return buildErrorResponse(
            new Error(
              `File is too large to return inline (${formatFileSize(file.data.length)}, limit ${formatFileSize(MAX_INBOX_UPLOAD_BYTES)}). ` +
              `Downloading very large files through this tool isn't supported.`
            )
          );
        }

        const output = {
          file_id: params.file_id,
          filename: file.filename || null,
          content_type: file.contentType,
          size_bytes: file.data.length,
          content_base64: file.data.toString("base64")
        };

        const textContent =
          `# Inbox File: ${file.filename || params.file_id}\n\n` +
          `**Content-Type**: ${file.contentType}\n` +
          `**Size**: ${formatFileSize(file.data.length)}\n\n` +
          `File content is available base64-encoded in the structured output ("content_base64").`;

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );

  // Upload a file to the inbox
  server.registerTool(
    "fortnox_upload_inbox_file",
    {
      title: "Upload File to Fortnox Inbox",
      description: `Upload a file to the Fortnox Inbox.

IMPORTANT: Provide file content as a base64-encoded string. This is the
practical way to pass binary data through an MCP tool call (no filesystem
access to the server is assumed), but it inflates payload size by ~33%
versus the raw bytes. Files whose decoded size exceeds ${Math.round(MAX_INBOX_UPLOAD_BYTES / (1024 * 1024))}MB are rejected.

Args:
  - filename (string): Filename to store, including extension (required)
  - content_base64 (string): File content, base64-encoded (required)
  - content_type (string): MIME type (e.g. 'application/pdf'). Defaults to application/octet-stream.
  - folder_id (string): Inbox folder Id to upload into. Omit to upload to the Inbox root.
  - response_format ('markdown' | 'json'): Output format

Returns:
  The uploaded file's Id, name, and size. Use the Id with
  fortnox_connect_file_to_voucher to attach it to a voucher.`,
      inputSchema: UploadInboxFileSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: UploadInboxFileInput) => {
      try {
        let buffer: Buffer;
        try {
          buffer = Buffer.from(params.content_base64, "base64");
        } catch {
          return buildErrorResponse(new Error("content_base64 is not valid base64 data."));
        }

        if (buffer.length === 0) {
          return buildErrorResponse(new Error("Decoded file content is empty."));
        }

        if (buffer.length > MAX_INBOX_UPLOAD_BYTES) {
          return buildErrorResponse(
            new Error(
              `File is too large (${formatFileSize(buffer.length)}, limit ${formatFileSize(MAX_INBOX_UPLOAD_BYTES)}).`
            )
          );
        }

        const response = await fortnoxUploadFile<FolderFileResponse>(
          "/3/inbox",
          {
            buffer,
            filename: params.filename,
            contentType: params.content_type
          },
          params.folder_id ? { folderId: params.folder_id } : undefined
        );
        const file = response.File;

        const output = {
          success: true,
          message: `File '${file.Name}' uploaded successfully`,
          file_id: file.Id,
          filename: file.Name,
          size_bytes: file.Size ?? buffer.length,
          path: file.Path || null
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          textContent = `# File Uploaded\n\n` +
            `**Name**: ${file.Name}\n` +
            `**Id**: \`${file.Id}\`\n` +
            `**Size**: ${formatFileSize(file.Size ?? buffer.length)}\n\n` +
            `Use this file Id with fortnox_connect_file_to_voucher to attach it to a voucher.`;
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );

  // Connect a file to a voucher
  server.registerTool(
    "fortnox_connect_file_to_voucher",
    {
      title: "Connect File to Voucher",
      description: `Attach an uploaded file (e.g. a receipt) to an existing voucher as supporting documentation.

The file must already exist in Fortnox (e.g. uploaded via fortnox_upload_inbox_file)
and the voucher must already exist (e.g. created via fortnox_create_voucher).

Args:
  - file_id (string): File Id to attach (required)
  - voucher_series (string): Voucher series (e.g. 'A') (required)
  - voucher_number (number): Voucher number within the series (required)
  - voucher_year (number): Fortnox financial year ID (optional, disambiguates repeated voucher numbers across years)
  - response_format ('markdown' | 'json'): Output format

Returns:
  Confirmation of the file-voucher connection.`,
      inputSchema: ConnectFileToVoucherSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: ConnectFileToVoucherInput) => {
      try {
        const connectionData: Record<string, unknown> = {
          FileId: params.file_id,
          VoucherSeries: params.voucher_series,
          VoucherNumber: String(params.voucher_number)
        };
        if (params.voucher_year !== undefined) {
          connectionData.VoucherYear = params.voucher_year;
        }

        const response = await fortnoxRequest<VoucherFileConnectionResponse>(
          "/3/voucherfileconnections",
          "POST",
          { VoucherFileConnection: connectionData }
        );
        const connection = response.VoucherFileConnection;

        const output = {
          success: true,
          message: `File connected to voucher ${connection.VoucherSeries}${connection.VoucherNumber}`,
          file_id: connection.FileId,
          voucher_series: connection.VoucherSeries,
          voucher_number: connection.VoucherNumber,
          voucher_year: connection.VoucherYear ?? null
        };

        let textContent: string;
        if (params.response_format === ResponseFormat.JSON) {
          textContent = JSON.stringify(output, null, 2);
        } else {
          textContent = `# File Connected to Voucher\n\n` +
            `**File Id**: \`${connection.FileId}\`\n` +
            `**Voucher**: ${connection.VoucherSeries}${connection.VoucherNumber}\n\n` +
            `The file is now attached as supporting documentation for this voucher.`;
        }

        return buildToolResponse(textContent, output);
      } catch (error) {
        return buildErrorResponse(error);
      }
    }
  );
}
