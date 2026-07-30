declare module "@jscad/3mf-serializer" {
  export function serialize(options: Record<string, unknown>, ...objects: unknown[]): Array<ArrayBuffer | Uint8Array | string>;
  export const mimeType: string;
}

declare module "@jscad/stl-serializer" {
  export function serialize(options: Record<string, unknown>, ...objects: unknown[]): Array<ArrayBuffer | Uint8Array | string>;
  export const mimeType: string;
}
