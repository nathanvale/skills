import { isReassigned } from "./anti-slop-bindings.mjs";

const assertionTypes = new Set(["TSAsExpression", "TSTypeAssertion"]);

const typeScopeTypes = new Set([
  "Program",
  "BlockStatement",
  "TSModuleBlock",
  "StaticBlock",
  "SwitchStatement",
]);
const namedTypeDeclarations = new Set([
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "ClassDeclaration",
  "ClassExpression",
]);
const importSpecifiers = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
]);

const isNode = (value) =>
  typeof value === "object" && value !== null && typeof value.type === "string";

function forEachChild(node, visitorKeys, visit) {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (isNode(value)) visit(value);
    else if (Array.isArray(value))
      for (const child of value) if (isNode(child)) visit(child);
  }
}

function enclosingTypeScope(node) {
  for (let current = node.parent; current; current = current.parent)
    if (typeScopeTypes.has(current.type)) return current;
  return node;
}

function declaredTypeBinding(node) {
  if (node.type === "TSTypeAliasDeclaration")
    return { alias: node, name: node.id.name };
  if (namedTypeDeclarations.has(node.type))
    return node.id ? { alias: null, name: node.id.name } : null;
  if (importSpecifiers.has(node.type))
    return { alias: null, name: node.local.name };
  return null;
}

function collectTypeBindings(node, visitorKeys, bindingsByName) {
  const declared = declaredTypeBinding(node);
  if (declared !== null) {
    const bindings = bindingsByName.get(declared.name) ?? [];
    bindings.push({ ...declared, scope: enclosingTypeScope(node) });
    bindingsByName.set(declared.name, bindings);
  }
  forEachChild(node, visitorKeys, (child) =>
    collectTypeBindings(child, visitorKeys, bindingsByName),
  );
}

function createTypeAliasEnvironment(program, visitorKeys) {
  const bindingsByName = new Map();
  collectTypeBindings(program, visitorKeys, bindingsByName);
  return { bindingsByName, visitorKeys };
}

function collectInferTypeParameterNames(node, visitorKeys, names) {
  if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
  forEachChild(node, visitorKeys, (child) =>
    collectInferTypeParameterNames(child, visitorKeys, names),
  );
}

function lexicalTypeParameterNames(node, visitorKeys) {
  const names = new Set();
  let descendant = node;
  for (
    let current = node;
    current && current.type !== "Program";
    current = current.parent
  ) {
    for (const parameter of current.typeParameters?.params ?? [])
      names.add(parameter.name.name);
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    )
      names.add(current.key.name);
    if (current.type === "TSConditionalType" && descendant === current.trueType)
      collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
    descendant = current;
  }
  return names;
}

function ancestorDistance(ancestor, node) {
  let distance = 0;
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return distance;
    distance += 1;
  }
  return null;
}

function nearestTypeBindings(name, use, environment) {
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest = [];
  for (const candidate of environment.bindingsByName.get(name) ?? []) {
    const distance = ancestorDistance(candidate.scope, use);
    if (distance === null || distance > nearestDistance) continue;
    if (distance === nearestDistance) {
      nearest.push(candidate);
      continue;
    }
    nearestDistance = distance;
    nearest = [candidate];
  }
  return nearest;
}

function visibleTypeAlias(name, use, environment) {
  if (lexicalTypeParameterNames(use, environment.visitorKeys).has(name))
    return null;
  const bindings = nearestTypeBindings(name, use, environment);
  return bindings.length === 1 ? (bindings[0].alias ?? null) : null;
}

function aliasSubstitutions(alias, reference, base, expansion) {
  const parameters = alias.typeParameters?.params ?? [];
  const typeArguments = reference.typeArguments?.params ?? [];
  const next = new Map();
  for (const [index, parameter] of parameters.entries()) {
    const explicitArgument = typeArguments[index];
    const argument = explicitArgument ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    const [substitutions, resolvingAliases] =
      explicitArgument === undefined
        ? [next, expansion.innerAliases]
        : [base, expansion.resolvingAliases];
    next.set(parameter.name.name, {
      type: argument,
      substitutions: new Map(substitutions),
      resolvingAliases,
    });
  }
  return next;
}

const typeReferenceName = (type) =>
  type.typeName.type === "Identifier" ? type.typeName.name : null;

function resolvedTypeMatches(type, environment, matcher) {
  const evaluate = (current, substitutions, resolvingAliases) => {
    const name =
      current.type === "TSTypeReference" ? typeReferenceName(current) : null;
    if (name !== null) {
      const substitution = substitutions.get(name);
      if (substitution !== undefined && !current.typeArguments?.params.length)
        return evaluate(
          substitution.type,
          substitution.substitutions,
          substitution.resolvingAliases,
        );
      const alias = visibleTypeAlias(name, current, environment);
      const innerAliases = new Set([...resolvingAliases, alias]);
      const nextSubstitutions =
        alias !== null && !resolvingAliases.has(alias)
          ? aliasSubstitutions(alias, current, substitutions, {
              resolvingAliases,
              innerAliases,
            })
          : null;
      if (nextSubstitutions !== null)
        return evaluate(alias.typeAnnotation, nextSubstitutions, innerAliases);
    }
    return matcher(current, (child) =>
      evaluate(child, substitutions, resolvingAliases),
    );
  };
  return evaluate(type, new Map(), new Set());
}

export const noUnknownTypeAliases = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  create(context) {
    let environment = null;
    const resolvesToUnknown = (type) =>
      environment !== null &&
      resolvedTypeMatches(
        type,
        environment,
        (resolved, matches) =>
          resolved.type === "TSUnknownKeyword" ||
          (resolved.type === "TSUnionType" && resolved.types.some(matches)),
      );
    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys,
        );
      },
      TSTypeAliasDeclaration(node) {
        if (!resolvesToUnknown(node.typeAnnotation)) return;
        context.report({
          node: node.id,
          messageId: "unknownAlias",
          data: { alias: node.id.name },
        });
      },
    };
  },
};

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);
const broadKeyTypes = new Set([
  "TSStringKeyword",
  "TSNumberKeyword",
  "TSSymbolKeyword",
]);
const topTypes = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);
const definitelyObjectTypes = new Set([
  "TSArrayType",
  "TSConstructorType",
  "TSFunctionType",
  "TSMappedType",
  "TSObjectKeyword",
  "TSTupleType",
]);
const knownValueTypes = new Set([
  "Literal",
  "TemplateLiteral",
  "ArrayExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
  "FunctionExpression",
  "NewExpression",
  "ObjectExpression",
]);

const isUnknownOrAnyType = (type) => topTypes.has(type.type);

function isBroadRecordKeyType(type) {
  if (broadKeyTypes.has(type.type)) return true;
  if (type.type === "TSUnionType")
    return type.types.every(isBroadRecordKeyType);
  return (
    type.type === "TSTypeReference" && typeReferenceName(type) === "PropertyKey"
  );
}

function isBroadRecordReference(type) {
  const name = typeReferenceName(type);
  const parameters = type.typeArguments?.params ?? [];
  if (name === "Readonly")
    return parameters[0] !== undefined && isBroadRecordType(parameters[0]);
  return (
    name === "Record" &&
    parameters.length === 2 &&
    isBroadRecordKeyType(parameters[0]) &&
    isUnknownOrAnyType(parameters[1])
  );
}

function isBroadRecordType(type) {
  if (type.type === "TSTypeReference") return isBroadRecordReference(type);
  if (type.type !== "TSTypeLiteral" || type.members.length !== 1) return false;
  const [member] = type.members;
  const [parameter] =
    member.type === "TSIndexSignature" ? member.parameters : [];
  const keyType = parameter?.typeAnnotation?.typeAnnotation;
  const valueType = member.typeAnnotation?.typeAnnotation;
  return (
    member.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    keyType !== undefined &&
    valueType !== undefined &&
    isBroadRecordKeyType(keyType) &&
    isUnknownOrAnyType(valueType)
  );
}

function broadTypeKind(type) {
  if (topTypes.has(type.type)) return "top";
  if (type.type === "TSObjectKeyword") return "object";
  return isBroadRecordType(type) ? "record" : null;
}

const assertionFromExpression = (expression) =>
  assertionTypes.has(expression.type) ? expression : null;

const normalizedTypeText = (sourceText, type) =>
  sourceText.slice(type.range[0], type.range[1]).replaceAll(/\s+/gu, "");

const typesHaveSameSyntax = (sourceText, left, right) =>
  left !== null &&
  normalizedTypeText(sourceText, left) ===
    normalizedTypeText(sourceText, right);

function isDefinitelyObjectType(type) {
  if (definitelyObjectTypes.has(type.type)) return true;
  if (type.type === "TSTypeLiteral") return type.members.length > 0;
  if (type.type === "TSIntersectionType")
    return type.types.every(isDefinitelyObjectType);
  return (
    type.type === "TSTypeOperator" &&
    type.operator === "readonly" &&
    isDefinitelyObjectType(type.typeAnnotation)
  );
}

function isDefinitelyNarrowerRecordType(type) {
  if (type.type === "TSTypeLiteral")
    return type.members.some((member) => member.type !== "TSIndexSignature");
  if (type.type !== "TSTypeReference") return false;
  const name = typeReferenceName(type);
  const parameters = type.typeArguments?.params ?? [];
  if (name === "Readonly")
    return (
      parameters[0] !== undefined &&
      isDefinitelyNarrowerRecordType(parameters[0])
    );
  return (
    name === "Record" &&
    parameters.length === 2 &&
    !isUnknownOrAnyType(parameters[1])
  );
}

function functionBoundary(node) {
  for (
    let current = node.parent;
    current && current.type !== "Program";
    current = current.parent
  )
    if (functionBoundaryTypes.has(current.type)) return current;
  return null;
}

function resolvedVariableForIdentifier(scopes, identifier) {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.range[0] === identifier.range[0] &&
        candidate.identifier.range[1] === identifier.range[1],
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function variableDeclarator(variable) {
  for (const definition of variable.defs)
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator"
    )
      return definition.node;
  return null;
}

function annotatedEvidence(variable, boundary) {
  const annotatedIdentifier = variable.identifiers.find(
    (identifier) =>
      identifier.typeAnnotation !== null &&
      identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation === undefined) return undefined;
  if (
    functionBoundary(annotatedIdentifier) !== boundary ||
    broadTypeKind(annotation) !== null
  )
    return null;
  return { type: annotation };
}

function isLocalConst(declarator, variable, boundary) {
  return (
    declarator !== null &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    declarator.init !== null &&
    !isReassigned(variable) &&
    functionBoundary(declarator) === boundary
  );
}

function knownValueEvidence(expression, scopes, boundary, visitedVariables) {
  if (assertionTypes.has(expression.type))
    return broadTypeKind(expression.typeAnnotation) !== null
      ? null
      : { type: expression.typeAnnotation };
  if (knownValueTypes.has(expression.type)) return { type: null };
  if (expression.type !== "Identifier") return null;
  const variable = resolvedVariableForIdentifier(scopes, expression);
  if (variable === null || visitedVariables.has(variable)) return null;
  const annotated = annotatedEvidence(variable, boundary);
  if (annotated !== undefined) return annotated;
  const declarator = variableDeclarator(variable);
  if (!isLocalConst(declarator, variable, boundary)) return null;
  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

function widenedBinding(variable, scopes) {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    isReassigned(variable)
  )
    return null;
  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null
      ? null
      : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind =
    declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;
  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? initializerAssertion.expression
      : declarator.init;
  const evidence = knownValueEvidence(
    originalExpression,
    scopes,
    boundary,
    new Set([variable]),
  );
  return evidence === null
    ? null
    : { broadKind, evidence, declaredAt: declarator.range[1], boundary };
}

function assertionIsNarrower(sourceText, broadKind, evidence, assertedType) {
  if (broadTypeKind(assertedType) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType);
  return isDefinitelyNarrowerRecordType(assertedType);
}

export const noWidenThenAssert = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  create(context) {
    let scopes = [];
    const checkAssertion = (node) => {
      const { expression } = node;
      if (expression.type !== "Identifier") return;
      const variable = resolvedVariableForIdentifier(scopes, expression);
      if (variable === null) return;
      const widened = widenedBinding(variable, scopes);
      if (
        widened === null ||
        node.range[0] <= widened.declaredAt ||
        functionBoundary(node) !== widened.boundary ||
        !assertionIsNarrower(
          context.sourceCode.text,
          widened.broadKind,
          widened.evidence,
          node.typeAnnotation,
        )
      )
        return;
      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };
    return {
      Program() {
        scopes = context.sourceCode.scopeManager.scopes;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
