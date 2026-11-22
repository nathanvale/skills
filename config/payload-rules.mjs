import ts from "typescript";

const prototypeOwners = new Set([
  "Object",
  "Function",
  "CallableFunction",
  "NewableFunction",
]);

function typeServices(context) {
  const services = context.sourceCode.parserServices;
  return services?.program ? services : undefined;
}

function members(type) {
  return type.isUnion() ? type.types : [type];
}

function stable(node) {
  if (node.type === "Identifier" || node.type === "Literal") return true;
  return node.type === "TemplateLiteral" && node.expressions.length === 0;
}

function named(member, name) {
  const { property } = member;
  if (!member.computed)
    return property.type === "Identifier" && property.name === name;
  if (property.type === "Literal") return property.value === name;
  if (property.type !== "TemplateLiteral" || property.expressions.length > 0)
    return false;
  const [{ value }] = property.quasis;
  return (value.cooked ?? value.raw) === name;
}

function taken(scope) {
  const names = new Set();
  const below = (inner) => {
    for (const variable of inner.variables) names.add(variable.name);
    for (const reference of inner.references)
      names.add(reference.identifier.name);
    inner.childScopes.forEach(below);
  };
  below(scope);
  for (let upper = scope.upper; upper; upper = upper.upper)
    for (const variable of upper.variables) names.add(variable.name);
  return names;
}

function fresh(names, base) {
  let name = base;
  for (let count = 2; names.has(name); count += 1) name = `${base}${count}`;
  names.add(name);
  return name;
}

export default {
  rules: {
    "no-in-operator": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          in: "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString, so a payload passes a check for a key it never had; check own data and read it into a place typed unknown. Repair: (Object.hasOwn({{target}}, {{key}}) ? Reflect.get({{target}}, {{key}}) : undefined)",
          inBound:
            "{{key}} is not declared on this type, and {{how}} also finds inherited members such as toString; a second evaluation of {{target}} or {{key}} may yield another value, so bind both once, in the order {{how}} evaluates them, then read the own value into a place typed unknown. Repair: {{bindings}} const {{ownName}}: unknown = Object.hasOwn({{targetName}}, {{keyName}}) ? Reflect.get({{targetName}}, {{keyName}}) : undefined;",
          forIn:
            "for...in also walks inherited enumerable keys. Repair: for ({{binding}} of Object.keys({{target}}))",
        },
      },
      create(context) {
        const services = typeServices(context);
        if (!services) return {};
        const { program } = services;
        const checker = program.getTypeChecker();
        const text = (node) => context.sourceCode.getText(node);
        // Platform: Every object type resolves the Object.prototype members, and
        // every function type the Function.prototype ones, so a key found
        // only there is inherited, not declared.
        const inherited = (declaration) =>
          ts.isInterfaceDeclaration(declaration.parent) &&
          prototypeOwners.has(declaration.parent.name.text) &&
          program.isSourceFileDefaultLibrary(declaration.getSourceFile());
        const own = (symbol) =>
          symbol !== undefined &&
          !(
            symbol.declarations?.length && symbol.declarations.every(inherited)
          );
        const propertyOf = (type, key) => {
          if (key.isStringLiteral() || key.isNumberLiteral())
            return checker.getPropertyOfType(type, String(key.value));
          if (key.flags & ts.TypeFlags.UniqueESSymbol)
            return checker
              .getPropertiesOfType(type)
              .find((property) => property.escapedName === key.escapedName);
          return undefined;
        };
        const declared = (keyNode, targetNode) => {
          const keys = members(services.getTypeAtLocation(keyNode));
          const targets = members(
            services.getTypeAtLocation(targetNode),
          ).flatMap((type) => members(checker.getApparentType(type)));
          return keys.every((key) =>
            targets.some((type) => own(propertyOf(type, key))),
          );
        };
        const check = (node, keyNode, targetNode, how) => {
          if (declared(keyNode, targetNode)) return;
          const data = { key: text(keyNode), target: text(targetNode), how };
          if (stable(keyNode) && stable(targetNode)) {
            context.report({ node, messageId: "in", data });
            return;
          }
          const names = taken(context.sourceCode.getScope(node));
          const keyName = fresh(names, "key");
          const targetName = fresh(names, "target");
          const ownName = fresh(names, "own");
          const key = `const ${keyName} = ${data.key};`;
          const target = `const ${targetName} = ${data.target};`;
          const bindings =
            how === "Reflect.has" ? `${target} ${key}` : `${key} ${target}`;
          context.report({
            node,
            messageId: "inBound",
            data: { ...data, bindings, keyName, targetName, ownName },
          });
        };
        return {
          "BinaryExpression[operator='in']:not([left.type='PrivateIdentifier'])"(
            node,
          ) {
            check(node, node.left, node.right, "the in operator");
          },
          "CallExpression[callee.type='MemberExpression'][callee.object.name='Reflect'][arguments.length=2]"(
            node,
          ) {
            if (named(node.callee, "has"))
              check(node, node.arguments[1], node.arguments[0], "Reflect.has");
          },
          ForInStatement(node) {
            context.report({
              node,
              messageId: "forIn",
              data: { binding: text(node.left), target: text(node.right) },
            });
          },
        };
      },
    },
  },
};
