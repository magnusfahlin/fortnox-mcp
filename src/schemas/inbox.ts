import { z } from "zod";
import { ResponseFormat } from "../constants.js";
import { PaginationSchema } from "./common.js";

/**
 * Maximum decoded file size accepted for Inbox uploads.
 *
 * Upload content travels as a base64 string inside the tool call JSON, which
 * inflates size by ~33% and consumes context/token budget on both the
 * request and (if echoed back) the response. 15MB decoded keeps typical
 * receipts/invoices/PDFs comfortably within reach while avoiding pathological
 * payloads being pushed through the model context window.
 */
export const MAX_INBOX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Schema for listing Fortnox Inbox files/folders
 */
export const ListInboxFilesSchema = z.object({
  folder_id: z.string()
    .min(1)
    .max(100)
    .optional()
    .describe("Inbox folder Id to list the contents of. Omit to list the Inbox root folder."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type ListInboxFilesInput = z.infer<typeof ListInboxFilesSchema>;

/**
 * Schema for downloading a single Fortnox Inbox file
 */
export const GetInboxFileSchema = z.object({
  file_id: z.string()
    .min(1)
    .describe("Inbox file Id to download (from fortnox_list_inbox_files)")
}).strict();

export type GetInboxFileInput = z.infer<typeof GetInboxFileSchema>;

/**
 * Schema for uploading a file to the Fortnox Inbox
 */
export const UploadInboxFileSchema = z.object({
  filename: z.string()
    .min(1)
    .max(255)
    .describe("Filename to store in Fortnox, including extension (e.g. 'receipt.pdf')"),
  content_base64: z.string()
    .min(1)
    .describe("File content, base64-encoded"),
  content_type: z.string()
    .max(100)
    .optional()
    .describe("MIME type of the file (e.g. 'application/pdf', 'image/jpeg'). Defaults to application/octet-stream."),
  folder_id: z.string()
    .min(1)
    .max(100)
    .optional()
    .describe("Inbox folder Id to upload into. Omit to upload to the Inbox root."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type UploadInboxFileInput = z.infer<typeof UploadInboxFileSchema>;

/**
 * Schema for connecting an uploaded file to a voucher
 */
export const ConnectFileToVoucherSchema = z.object({
  file_id: z.string()
    .min(1)
    .describe("File Id to attach (e.g. the Id returned by fortnox_upload_inbox_file or fortnox_list_inbox_files)"),
  voucher_series: z.string()
    .min(1)
    .max(2)
    .describe("Voucher series the target voucher belongs to (e.g. 'A') (required)"),
  voucher_number: z.number()
    .int()
    .min(1)
    .describe("Voucher number within the series (required)"),
  voucher_year: z.number()
    .int()
    .optional()
    .describe("Fortnox financial year ID the voucher belongs to (1, 2, 3...). NOT calendar year. Optional, but disambiguates if voucher numbers repeat across years."),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("Output format: 'markdown' or 'json'")
}).strict();

export type ConnectFileToVoucherInput = z.infer<typeof ConnectFileToVoucherSchema>;

/**
 * Schema for listing voucher file connections / looking up one file's connection
 */
export const ListVoucherFileConnectionsSchema = PaginationSchema.extend({
  file_id: z.string()
    .min(1)
    .max(100)
    .optional()
    .describe("File Id to look up (e.g. an Inbox file Id from fortnox_list_inbox_files). Omit to list all voucher file connections (paginated with limit/page).")
}).strict();

export type ListVoucherFileConnectionsInput = z.infer<typeof ListVoucherFileConnectionsSchema>;
