const hostRoots =
  /^\/(?:private|usr|var|tmp|etc|opt|Users|home|Library|System)(?:\/|$)/;

export default {
  rules: {
    "no-host-path-literal": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          host: '"{{path}}" names a folder on one host\'s filesystem, so the code fails on the other OS: /private/tmp exists only on macOS, and what sits under /usr/share differs between hosts. Repair: make a scratch folder with testFolder(prefix) from tests/support/test-folder.ts, or derive the system path from the host and check its precondition with a test-owned read.',
        },
      },
      create(context) {
        const report = (node, path) => {
          if (hostRoots.test(path))
            context.report({ node, messageId: "host", data: { path } });
        };
        return {
          Literal(node) {
            if (typeof node.value === "string") report(node, node.value);
          },
          TemplateLiteral(node) {
            report(
              node,
              node.quasis[0].value.cooked ?? node.quasis[0].value.raw,
            );
          },
        };
      },
    },
  },
};
