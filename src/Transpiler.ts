import * as ts from "typescript";

import {TSHelper as tsEx} from "./TSHelper";
import {ForHelper} from "./ForHelper";

export class TranspileError extends Error {
    node: ts.Node;
    constructor(message: string, node: ts.Node) {
        super(message);
        this.node = node;
    }
}

export class LuaTranspiler {
    // Transpile a source file
    static transpileSourceFile(node: ts.SourceFile, checker: ts.TypeChecker): string {
        let transpiler = new LuaTranspiler(checker);
        return transpiler.transpileBlock(node);
    }

    indent: string;
    checker: ts.TypeChecker;
    switchCounter: number;
    transpilingSwitch: boolean;

    constructor(checker: ts.TypeChecker) {
        this.indent = "";
        this.checker = checker;
        this.switchCounter = 0;
        this.transpilingSwitch = false;
    }

    pushIndent(): void {
        this.indent = this.indent + "    ";
    }

    popIndent(): void {
        this.indent = this.indent.slice(4);
    }

    // Transpile a block
     transpileBlock(node: ts.Node): string {
        let result = "";

        node.forEachChild(child => {
            result += this.transpileNode(child);
        })

        return result;
    }

    // Transpile a node of unknown kind.
    transpileNode(node: ts.Node): string {
        //Ignore declarations
        if (tsEx.getChildrenOfType(node, child => child.kind == ts.SyntaxKind.DeclareKeyword).length > 0) return "";

        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                return this.transpileImport(<ts.ImportDeclaration>node);
            case ts.SyntaxKind.ClassDeclaration:
                return this.transpileClass(<ts.ClassDeclaration>node);
            case ts.SyntaxKind.EnumDeclaration:
                return this.transpileEnum(<ts.EnumDeclaration>node);
            case ts.SyntaxKind.FunctionDeclaration:
                return this.transpileFunctionDeclaration(<ts.FunctionDeclaration>node, "");
            case ts.SyntaxKind.VariableStatement:
                return this.indent + this.transpileVariableStatement(<ts.VariableStatement>node) + "\n";
            case ts.SyntaxKind.ExpressionStatement:
                return this.indent + this.transpileExpression(<ts.Expression>tsEx.getChildren(node)[0]) + "\n";
            case ts.SyntaxKind.ReturnStatement:
                return this.indent + this.transpileReturn(<ts.ReturnStatement>node) + "\n";
            case ts.SyntaxKind.IfStatement:
                return this.transpileIf(<ts.IfStatement>node);
            case ts.SyntaxKind.WhileStatement:
                return this.transpileWhile(<ts.WhileStatement>node);
            case ts.SyntaxKind.ForStatement:
                return this.transpileFor(<ts.ForStatement>node);
            case ts.SyntaxKind.ForOfStatement:
                return this.transpileForOf(<ts.ForOfStatement>node);
            case ts.SyntaxKind.ForInStatement:
                return this.transpileForIn(<ts.ForInStatement>node);
            case ts.SyntaxKind.SwitchStatement:
                return this.transpileSwitch(<ts.SwitchStatement>node);
            case ts.SyntaxKind.BreakStatement:
                return this.transpileBreak();
            case ts.SyntaxKind.ContinueKeyword:
                // Disallow continue
                throw new TranspileError("Continue is not supported in Lua", node);
            case ts.SyntaxKind.TypeAliasDeclaration:
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.EndOfFileToken:
                // Ignore these
                return "";
            default:
                throw new TranspileError("Unsupported node kind: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpileImport(node: ts.ImportDeclaration): string {
        const name = this.transpileExpression(node.moduleSpecifier);
        const imports = node.importClause.namedBindings;
        if (ts.isNamespaceImport(imports)) {
            return `{$imports.name.escapedText} = require(${name})`;
        } else if (ts.isNamedImports(imports)) {
            // Forbid renaming
            imports.elements.forEach(element => {
                if(element.propertyName) {
                    throw new TranspileError("Renaming of individual imported objects is not allowed", node);
                }
            });
            return `require(${name})`;
        } else {
            throw new TranspileError("Unsupported import type.", node);
        }
    }

    transpileEnum(node: ts.EnumDeclaration): string {
        let val = 0;
        let result = "";
        node.members.forEach(member => {
            if (member.initializer) {
                if (ts.isNumericLiteral(member.initializer)) {
                    val = parseInt(member.initializer.text);
                } else {
                    throw new TranspileError("Only numeric initializers allowed for enums.", node);
                }
            }

            const name = (<ts.Identifier>member.name).escapedText;
            result += this.indent + `${name}=${val}\n`;

            val++;
        });
        return result;
    }

    transpileBreak(): string {
        if (this.transpilingSwitch) {
            return this.indent + `goto switchDone${this.switchCounter}\n`;
        } else {
            return this.indent + "break\n";
        }
    }

    transpileIf(node: ts.IfStatement): string {
        const condition = this.transpileExpression(node.expression);

        let result = this.indent + `if ${condition} then\n`;
        this.pushIndent();
        result += this.transpileBlock(node.thenStatement);
        this.popIndent();

        if (node.elseStatement) {
            result += this.indent + "else\n";
            this.pushIndent();
            result += this.transpileBlock(node.elseStatement);
            this.popIndent();
        }

        return result + this.indent + "end\n";
    }

    transpileWhile(node: ts.WhileStatement): string {
        const condition = this.transpileExpression(node.expression);

        let result = this.indent + `while ${condition} do\n`;
        this.pushIndent();
        result += this.transpileBlock(node.statement);
        this.popIndent();
        return result + this.indent + "end\n";
    }

    transpileFor(node: ts.ForStatement): string {
        // Get iterator variable
        const variable = (<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Populate three components of lua numeric for loop:
        let start = this.transpileExpression(variable.initializer);
        let end = ForHelper.GetForEnd(node.condition, this);
        let step = ForHelper.GetForStep(node.incrementor, this);

        // Add header
        let result = this.indent + `for ${identifier.escapedText}=${start},${end},${step} do\n`;

        // Add body
        this.pushIndent();
        result += this.transpileBlock(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileForOf(node: ts.ForOfStatement): string {
        // Get variable identifier
        const variable =  (<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Transpile expression
        const expression = this.transpileExpression(node.expression);

        // Use ipairs for array types, pairs otherwise
        const isArray = this.checker.getTypeAtLocation(node.expression).symbol.escapedName == "Array";
        const pairs = isArray ? "ipairs" : "pairs";

        // Make header
        let result = this.indent + `for _, ${identifier.escapedText} in ${pairs}(${expression}) do\n`;

        // For body
        this.pushIndent();
        result += this.transpileBlock(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileForIn(node: ts.ForInStatement): string {
        // Get variable identifier
        const variable = <ts.VariableDeclaration>(<ts.VariableDeclarationList>node.initializer).declarations[0];
        const identifier = <ts.Identifier>variable.name;

        // Transpile expression
        const expression = this.transpileExpression(node.expression);

        // Use ipairs for array types, pairs otherwise
        const isArray = this.checker.getTypeAtLocation(node.expression).symbol.escapedName == "Array";
        const pairs = isArray ? "ipairs" : "pairs";

        // Make header
        let result = this.indent + `for ${identifier.escapedText}, _ in ${pairs}(${expression}) do\n`;

        // For body
        this.pushIndent();
        result += this.transpileBlock(node.statement);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileSwitch(node: ts.SwitchStatement): string {
        const expression = this.transpileExpression(node.expression, true);
        const clauses = node.caseBlock.clauses;

        let result = this.indent + "-------Switch statement start-------\n";

        // If statement to go to right entry label
        clauses.forEach((clause, index) => {
            if (ts.isCaseClause(clause)) {
                let keyword = index == 0 ? "if" : "elseif";
                let condition = this.transpileExpression(clause.expression, true);
                result += this.indent + `${keyword} ${expression}==${condition} then\n`;
            } else {
                // Default
                result += this.indent + `else\n`;
            }

            this.pushIndent();

            // Labels for fallthrough
            result += this.indent + `::switchCase${this.switchCounter+index}::\n`;

            this.transpilingSwitch = true;
            clause.statements.forEach(statement => {
                result += this.transpileNode(statement);
            });
            this.transpilingSwitch = false;

            // If this goto is reached, fall through to the next case
            if (index < clauses.length - 1) {
                result += this.indent + `goto switchCase${this.switchCounter + index + 1}\n`;
            }

            this.popIndent();
        });
        result += this.indent + "end\n";
        result += this.indent + `::switchDone${this.switchCounter}::\n`;
        result += this.indent + "--------Switch statement end--------\n";

        //Increment counter for next switch statement
        this.switchCounter += clauses.length;
        return result;
    }

    transpileReturn(node: ts.ReturnStatement): string {
        return "return " + this.transpileExpression(node.expression);
    }

    transpileExpression(node: ts.Node, brackets?: boolean): string {
        switch (node.kind) {
            case ts.SyntaxKind.BinaryExpression:
                // Add brackets to preserve ordering
                return this.transpileBinaryExpression(<ts.BinaryExpression>node, brackets);
            case ts.SyntaxKind.ConditionalExpression:
                // Add brackets to preserve ordering
                return this.transpileConditionalExpression(<ts.ConditionalExpression>node, brackets);
            case ts.SyntaxKind.CallExpression:
                return this.transpileCallExpression(<ts.CallExpression>node);
            case ts.SyntaxKind.PropertyAccessExpression:
                return this.transpilePropertyAccessExpression(<ts.PropertyAccessExpression>node);
            case ts.SyntaxKind.ElementAccessExpression:
                return this.transpileElementAccessExpression(<ts.ElementAccessExpression>node);
            case ts.SyntaxKind.Identifier:
                // For identifiers simply return their name
                return (<ts.Identifier>node).text;
            case ts.SyntaxKind.StringLiteral:
                const text = (<ts.StringLiteral>node).text;
                return `"${text}"`;
            case ts.SyntaxKind.NumericLiteral:
                return (<ts.NumericLiteral>node).text;
            case ts.SyntaxKind.TrueKeyword:
                return "true";
            case ts.SyntaxKind.FalseKeyword:
                return "false";
            case ts.SyntaxKind.PostfixUnaryExpression:
                return this.transpilePostfixUnaryExpression(<ts.PostfixUnaryExpression>node);
            case ts.SyntaxKind.PrefixUnaryExpression:
                return this.transpilePrefixUnaryExpression(<ts.PrefixUnaryExpression>node);
            case ts.SyntaxKind.ArrayLiteralExpression:
                return this.transpileArrayLiteral(<ts.ArrayLiteralExpression>node);
            case ts.SyntaxKind.ObjectLiteralExpression:
                return this.transpileObjectLiteral(<ts.ObjectLiteralExpression>node);
            case ts.SyntaxKind.FunctionExpression:
                return this.transpileFunctionExpression(<ts.FunctionExpression>node);
            case ts.SyntaxKind.NewExpression:
                return this.transpileNewExpression(<ts.NewExpression>node);
            case ts.SyntaxKind.TypeAssertionExpression:
                // Simply ignore the type assertion
                return this.transpileExpression((<ts.TypeAssertion>node).expression);
            default:
                throw new TranspileError("Unsupported expression kind: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpileBinaryExpression(node: ts.BinaryExpression, brackets?: boolean): string {
        // Transpile operands
        const lhs = this.transpileExpression(node.left, true);
        const rhs = this.transpileExpression(node.right, true);
        
        // Rewrite some non-existant binary operators
        let result = "";
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusEqualsToken:
                result = `${lhs}=${lhs}+${rhs}`;
                break;
            case ts.SyntaxKind.MinusEqualsToken:
                result = `${lhs}=${lhs}-${rhs}`;
                break;
            case ts.SyntaxKind.AmpersandAmpersandToken:
                result = `${lhs} and ${rhs}`;
                break;
            case ts.SyntaxKind.BarBarToken:
                result = `${lhs} or ${rhs}`;
                break;
            case ts.SyntaxKind.AmpersandToken:
                result = `bit.band(${lhs},${rhs})`;
                break;
            case ts.SyntaxKind.BarToken:
                result = `bit.bor(${lhs},${rhs})`;
                break;
            default:
                result = lhs + this.transpileOperator(node.operatorToken) + rhs;
        }

        // Optionally put brackets around result
        if (brackets) {
            return `(${result})`;
        } else {
            return result;
        }
    }

    transpileConditionalExpression(node: ts.ConditionalExpression, brackets?: boolean): string {
        let condition = this.transpileExpression(node.condition);
        let val1 = this.transpileExpression(node.whenTrue);
        let val2 = this.transpileExpression(node.whenFalse);

        return `ITE(${condition},function() return ${val1} end, function() return ${val2} end)`;
    }

    // Replace some missmatching operators
    transpileOperator<T extends ts.SyntaxKind>(operator: ts.Token<T>): string {
        switch (operator.kind) {
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                return "==";
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                return "~=";
            default:
                return ts.tokenToString(operator.kind);
        }
    }

    transpilePostfixUnaryExpression(node: ts.PostfixUnaryExpression): string {
        const operand = this.transpileExpression(node.operand);
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
                return `${operand} = ${operand} + 1`;
            case ts.SyntaxKind.MinusMinusToken:
                return `${operand} = ${operand} - 1`;
            default:
                throw new TranspileError("Unsupported expression kind: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpilePrefixUnaryExpression(node: ts.PrefixUnaryExpression): string {
        const operand = this.transpileExpression(node.operand);
        switch (node.operator) {
            case ts.SyntaxKind.PlusPlusToken:
                return `${operand} = ${operand} + 1`;
            case ts.SyntaxKind.MinusMinusToken:
                return `${operand} = ${operand} - 1`;
            case ts.SyntaxKind.ExclamationToken:
                return `not ${operand}`;
            default:
                throw new TranspileError("Unsupported expression kind: " + tsEx.enumName(node.kind, ts.SyntaxKind), node);
        }
    }

    transpileNewExpression(node: ts.NewExpression): string {
        const name = this.transpileExpression(node.expression);
        const params = this.transpileArguments(node.arguments);

        return `${name}(${params})`;
    }

    transpileCallExpression(node: ts.CallExpression): string {
        // Check for calls on primitives to override
        if (ts.isPropertyAccessExpression(node.expression)) {
            const type = this.checker.getTypeAtLocation(node.expression.expression);
            switch (type.flags) {
                case ts.TypeFlags.String:
                case ts.TypeFlags.StringLiteral:
                    return this.transpileStringCallExpression(node);
                case ts.TypeFlags.Object:
                    if (tsEx.isArrayType(type))
                        return this.transpileArrayCallExpression(node);
            }
        }

        let callPath = this.transpileExpression(node.expression);
        // Remove last . with :
        if (callPath.indexOf(".") > -1) {
            callPath = callPath.substr(0, callPath.lastIndexOf(".")) + ":" + callPath.substr(callPath.lastIndexOf(".") + 1);
        }

        const params = this.transpileArguments(node.arguments);
        return `${callPath}(${params})`;
    }

    transpileStringCallExpression(node: ts.CallExpression): string {
        const expression = <ts.PropertyAccessExpression>node.expression;
        const params = this.transpileArguments(node.arguments);
        const caller = this.transpileExpression(expression.expression);
        switch (expression.name.escapedText) {
            case "replace":
                return `${caller}:sub(${params})`;
            default:
                throw new TranspileError("Unsupported string function: " + expression.name.escapedText, node);
        }
    }

    transpileArrayCallExpression(node: ts.CallExpression): string {
        const expression = <ts.PropertyAccessExpression>node.expression;
        const params = this.transpileArguments(node.arguments);
        const caller = this.transpileExpression(expression.expression);
        switch (expression.name.escapedText) {
            case "push":
                return `table.insert(${caller}, ${params})`;
            default:
                throw new TranspileError("Unsupported array function: " + expression.name.escapedText, node);
        }
    }

    transpileArguments(params: ts.NodeArray<ts.Expression>): string {
        const parameters: string[] = [];
        params.forEach(param => {
            parameters.push(this.transpileExpression(param));
        });
        return parameters.join(",");
    }

    transpilePropertyAccessExpression(node: ts.PropertyAccessExpression): string {
        const property = node.name.text;
        
        // Check for primitive types to override
        const type = this.checker.getTypeAtLocation(node.expression);
        switch (type.flags) {
            case ts.TypeFlags.String:
            case ts.TypeFlags.StringLiteral:
                return this.transpileStringProperty(node);
            case ts.TypeFlags.Object:
                if (tsEx.isArrayType(type))
                    return this.transpileArrayProperty(node);
        }

        // Do regular handling
        switch(node.expression.kind) {
            case ts.SyntaxKind.ThisKeyword:
                return `self.${property}`;
            case ts.SyntaxKind.Identifier:
                // If identifier is enum translate to raw member
                if ((type.symbol.flags & ts.SymbolFlags.Enum) != 0) {
                    return property;
                } else {
                    let path = (<ts.Identifier>node.expression).text;
                    return `${path}.${property}`;
                }
            case ts.SyntaxKind.StringLiteral:
            case ts.SyntaxKind.NumericLiteral:
            case ts.SyntaxKind.ArrayLiteralExpression:
                let path = this.transpileExpression(node.expression);
                return `${path}.${property}`;
            case ts.SyntaxKind.CallExpression:
                path = this.transpileCallExpression(<ts.CallExpression>node.expression);
                return `${path}.${property}`;
            case ts.SyntaxKind.PropertyAccessExpression:
                path = this.transpilePropertyAccessExpression(<ts.PropertyAccessExpression>node.expression);
                return `${path}.${property}`;
            default:
                throw new TranspileError("Unsupported access kind: " + tsEx.enumName(node.expression.kind, ts.SyntaxKind), node);
        }
    }

    // Transpile access of string properties, only supported properties are allowed
    transpileStringProperty(node: ts.PropertyAccessExpression): string {
        const property = node.name;
        switch (property.escapedText) {
            case "length":
                return "#" + this.transpileExpression(node.expression);
            default:
                throw new TranspileError("Unsupported string property: " + property.escapedText, node);
        }
    }

    // Transpile access of array properties, only supported properties are allowed
    transpileArrayProperty(node: ts.PropertyAccessExpression): string {
        const property = node.name;
        switch (property.escapedText) {
            case "length":
                return "#" + this.transpileExpression(node.expression);
            default:
                throw new TranspileError("Unsupported array property: " + property.escapedText, node);
        }
    }

    transpileElementAccessExpression(node: ts.ElementAccessExpression): string {
        const element = this.transpileExpression(node.expression);
        const index = this.transpileExpression(node.argumentExpression);

        const isArray = tsEx.isArrayType(this.checker.getTypeAtLocation(node.expression));

        if (isArray) {
            return `${element}[${index}+1]`;
        } else {
            return `${element}[${index}]`;
        }
    }

    // Transpile a variable statement
    transpileVariableStatement(node: ts.VariableStatement): string {
        let result = "";

        node.declarationList.declarations.forEach(declaration => {
            result += this.transpileVariableDeclaration(<ts.VariableDeclaration>declaration);
        });

        return result;
    }

    transpileVariableDeclaration(node: ts.VariableDeclaration): string {
        // Find variable identifier
        const identifier = <ts.Identifier>node.name;
        const value = this.transpileExpression(node.initializer);

        return `local ${identifier.escapedText} = ${value}`;
    }

    transpileFunctionDeclaration(node: ts.Declaration, path: string): string {
        let result = "";
        const identifier = tsEx.getFirstChildOfType<ts.Identifier>(node, ts.isIdentifier);
        const methodName = identifier.escapedText;
        const parameters = tsEx.getChildrenOfType<ts.ParameterDeclaration>(node, ts.isParameter);
        const block = tsEx.getFirstChildOfType<ts.Block>(node, ts.isBlock);

        // Build parameter string
        let paramNames: string[] = [];
        parameters.forEach(param => {
            paramNames.push(<string>(<ts.Identifier>param.name).escapedText);
        });

        // Build function header
        result += this.indent + `function ${path}${methodName}(${paramNames.join(",")})\n`;

        this.pushIndent();
        result += this.transpileBlock(block);
        this.popIndent();

        // Close function block
        result += this.indent + "end\n";

        return result;
    }

    // Transpile a class declaration
    transpileClass(node: ts.ClassDeclaration): string {
        // Write class declaration
        const className = <string>node.name.escapedText;
        let result = this.indent + `${className} = ${className} or {}\n`;

        // Get all properties
        const properties = tsEx.getChildrenOfType<ts.PropertyDeclaration>(node, ts.isPropertyDeclaration);

        let staticFields: ts.PropertyDeclaration[] = [];
        let instanceFields: ts.PropertyDeclaration[] = [];

        // Divide properties in static and instance fields
        for (const p of properties) {
            // Check if property is static
            const isStatic = tsEx.getChildrenOfType(p, child => child.kind == ts.SyntaxKind.StaticKeyword).length > 0;

            // Find value assignment
            const assignments = tsEx.getChildrenOfType(p, tsEx.isValueType);
            
            // Ignore fields with no assigned value
            if (!p.initializer)
                continue;

            if (isStatic) {
                staticFields.push(p);
            } else {
                instanceFields.push(p);
            }
        }

        // Add static declarations
        for (const f of staticFields) {
            // Get identifier
            const fieldIdentifier = tsEx.getFirstChildOfType<ts.Identifier>(f, ts.isIdentifier);
            const fieldName = fieldIdentifier.escapedText;

            // Get value at index 1 (index 0 is field name)
            const valueNode = tsEx.getChildrenOfType<ts.Node>(f, tsEx.isValueType)[1];
            let value = this.transpileExpression(valueNode);            
            
            // Build lua assignment string
            result += this.indent + `${className}.${fieldName} = ${value}\n`;
        }

        // Try to find constructor
        const constructor = tsEx.getFirstChildOfType<ts.ConstructorDeclaration>(node, ts.isConstructorDeclaration);
        if (constructor) {
            // Add constructor plus initialisation of instance fields
            result += this.transpileConstructor(constructor, className, instanceFields);
        } else {
            // No constructor, make one to set all instance fields if there are any
            if (instanceFields.length > 0) {
                // Create empty constructor and add instance fields
                result += this.transpileConstructor(ts.createConstructor([],[],[], ts.createBlock([],true)), className, instanceFields);
            }
        }

        // Find all methods
        const methods = tsEx.getChildrenOfType<ts.MethodDeclaration>(node, ts.isMethodDeclaration);
        methods.forEach(method => {
            result += this.transpileFunctionDeclaration(method, `${className}:`);
        });

        return result;
    }

    transpileConstructor(node: ts.ConstructorDeclaration, className: string, instanceFields: ts.PropertyDeclaration[]): string {
        let result = this.indent + `function ${className}:constructor()\n`;

        // Add in instance field declarations
        for (const f of instanceFields) {
            // Get identifier
            const fieldIdentifier = <ts.Identifier>f.name;
            const fieldName = fieldIdentifier.escapedText;

            let value = this.transpileExpression(f.initializer);

            result += this.indent + `    self.${fieldName} = ${value}\n`;
        }

        // Transpile constructor body
        this.pushIndent();
        result += this.transpileBlock(node.body);
        this.popIndent();

        return result + this.indent + "end\n";
    }

    transpileArrayLiteral(node: ts.ArrayLiteralExpression): string {
        let values: string[] = [];

        node.elements.forEach(child => {
            values.push(this.transpileExpression(child));
        });

        return "{" + values.join(",") + "}";
    }

    transpileObjectLiteral(node: ts.ObjectLiteralExpression): string {
        let properties: string[] = [];
        // Add all property assignments
        node.properties.forEach(assignment => {
            const [key, value] = tsEx.getChildren(assignment);
            if (ts.isIdentifier(key)) {
                properties.push(`["${key.escapedText}"]=`+this.transpileExpression(value));
            } else {
                const index = this.transpileExpression(<ts.Expression>key);
                properties.push(`[${index}]=`+this.transpileExpression(value));
            }
        });

        return "{" + properties.join(",") + "}";
    }

    transpileFunctionExpression(node: ts.FunctionExpression): string {
        // Build parameter string
        let paramNames: string[] = [];
        node.parameters.forEach(param => {
            paramNames.push(<string>tsEx.getFirstChildOfType<ts.Identifier>(param, ts.isIdentifier).escapedText);
        });

        let result = `function(${paramNames.join(",")})\n`;
        this.pushIndent();
        result += this.transpileBlock(node.body);
        this.popIndent();
        return result + this.indent + "end ";
    }
}