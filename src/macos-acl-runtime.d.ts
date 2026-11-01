/** The JXA APIs used by macos-acl.js; checked against the macOS SDK and osascript. */
declare const nativePointer: unique symbol;
interface NativePointer {
  readonly [nativePointer]: true;
}
interface NativeReference {
  readonly 0: NativePointer | undefined;
}

interface FoundationData {
  readonly length: string;
}
interface MutableFoundationData extends FoundationData {
  readonly appendData: (data: FoundationData) => void;
}
interface FoundationString {
  readonly isNil: () => boolean;
  readonly dataUsingEncoding: (encoding: string) => FoundationData;
}
interface FoundationInput {
  readonly availableData: FoundationData;
}
interface FoundationOutput {
  readonly writeData: (data: FoundationData) => void;
}

interface AclBridge {
  (text: string): FoundationString;
  readonly acl_get_file: (path: string, type: number) => NativePointer;
  readonly acl_init: (entries: number) => NativePointer;
  readonly acl_valid: (acl: NativePointer) => number;
  readonly acl_get_entry: (acl: NativePointer, position: number, entry: NativeReference) => number;
  readonly acl_get_flagset_np: (entry: NativePointer, flags: NativeReference) => number;
  readonly acl_add_flag_np: (flags: NativePointer, flag: number) => number;
  readonly acl_set_link_np: (path: string, type: number, acl: NativePointer) => number;
  readonly acl_free: (pointer: NativePointer) => number;
  readonly __error: () => { readonly 0: number };
  readonly strerror: (error: number) => string;
  readonly NSUTF8StringEncoding: string;
  readonly NSFileHandle: {
    readonly fileHandleWithStandardInput: FoundationInput;
    readonly fileHandleWithStandardOutput: FoundationOutput;
  };
  readonly NSMutableData: { readonly data: MutableFoundationData };
  readonly NSString: {
    readonly alloc: {
      readonly initWithDataEncoding: (data: FoundationData, encoding: string) => FoundationString;
    };
  };
}

declare const $: AclBridge;
declare const ObjC: {
  readonly import: (framework: "Foundation") => void;
  readonly bindFunction: (
    name: keyof AclBridge,
    signature: readonly [string, readonly string[]],
  ) => void;
  readonly unwrap: (value: FoundationString) => string;
};
declare const Ref: () => NativeReference;
