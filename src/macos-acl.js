// Run by macOS /usr/bin/osascript, not Node. The native ACL API preserves UUIDs and
// entry order without translating principals through ls/chmod's name-based format.
ObjC.import("Foundation");
ObjC.bindFunction("acl_get_file", ["void *", ["char *", "int"]]);
ObjC.bindFunction("acl_init", ["void *", ["int"]]);
ObjC.bindFunction("acl_valid", ["int", ["void *"]]);
ObjC.bindFunction("acl_get_entry", ["int", ["void *", "int", "void **"]]);
ObjC.bindFunction("acl_get_flagset_np", ["int", ["void *", "void **"]]);
ObjC.bindFunction("acl_add_flag_np", ["int", ["void *", "unsigned int"]]);
ObjC.bindFunction("acl_set_link_np", ["int", ["char *", "int", "void *"]]);
ObjC.bindFunction("acl_free", ["int", ["void *"]]);
ObjC.bindFunction("__error", ["int *", []]);
ObjC.bindFunction("strerror", ["char *", ["int"]]);

// sys/acl.h: ACL_TYPE_EXTENDED and ACL_ENTRY_ONLY_INHERIT are both 0x100.
function check(result, operation) {
  if (result !== 0) {
    throw new Error(operation + ": " + $.strerror($.__error()[0]));
  }
}

function readAcl(path) {
  const acl = $.acl_get_file(path, 0x100);
  const readError = $.__error()[0];
  if ($.acl_valid(acl) === 0) {
    return acl;
  }
  // NULL/ENOENT means no extended ACL, including on non-ACL volumes.
  if (readError === 2) {
    return;
  }
  throw new Error("Read ACL: " + $.strerror(readError));
}

function transfer(mode, source, target) {
  let acl = readAcl(source);
  if (acl === undefined) {
    if (mode === "inherit") {
      return;
    }
    const existing = readAcl(target);
    if (existing === undefined) {
      return;
    }
    $.acl_free(existing);
    acl = $.acl_init(0);
    check($.acl_valid(acl), "Initialize empty ACL");
  }
  try {
    if (mode === "inherit") {
      // Forward the parent's rules without applying them to the private container.
      // macOS computes each child's ACL at the intended inheritance depth.
      const entry = Ref();
      for (let position = 0; $.acl_get_entry(acl, position, entry) === 0; position = -1) {
        const flags = Ref();
        check($.acl_get_flagset_np(entry[0], flags), "Read ACL flags");
        check($.acl_add_flag_np(flags[0], 0x100), "Set inherit-only flag");
      }
    }
    // Replacement copies retain the complete source ACL, including inherited entries
    // that cp -p otherwise replaces with the staging directory's inheritance.
    check($.acl_set_link_np(target, 0x100, acl), "Set staging ACL");
  } finally {
    $.acl_free(acl);
  }
}

function reply(line) {
  const request = JSON.parse(line);
  try {
    transfer(request.mode, request.source, request.target);
    return { id: request.id };
  } catch (error) {
    return { id: request.id, error: String(error instanceof Error ? error.message : error) };
  }
}

// One batch sends newline-delimited JSON requests and waits for each reply. A pipe read can
// end inside a UTF-8 sequence, so bytes are decoded only once they form complete text.
function serve() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const output = $.NSFileHandle.fileHandleWithStandardOutput;
  let bytes = $.NSMutableData.data;
  let text = "";
  for (let chunk = input.availableData; Number(chunk.length) > 0; chunk = input.availableData) {
    bytes.appendData(chunk);
    const decoded = $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding);
    if (!decoded.isNil()) {
      bytes = $.NSMutableData.data;
      const lines = (text + ObjC.unwrap(decoded)).split("\n");
      text = lines.pop();
      for (const line of lines) {
        const data = $(JSON.stringify(reply(line)) + "\n").dataUsingEncoding(
          $.NSUTF8StringEncoding,
        );
        output.writeData(data);
      }
    }
  }
}

function run(args) {
  if (args.length === 0) {
    serve();
  } else {
    transfer(args[0], args[1], args[2]);
  }
}
