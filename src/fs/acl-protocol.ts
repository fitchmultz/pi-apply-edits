export type AclMode = "inherit" | "copy";

export interface AclRequest {
  readonly id: number;
  readonly mode: AclMode;
  readonly source: string;
  readonly target: string;
}
