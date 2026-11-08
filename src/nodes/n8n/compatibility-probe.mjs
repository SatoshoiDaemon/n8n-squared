import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ExecutionEngine } from '../../execution/engine.js';
import { GraphExecutionEngine, NodeAdapterRegistry } from '../../execution/graph-engine.ts';
import { WorkflowService } from '../../workflows/service.js';
import { N8nNodePackageRuntime } from './runtime.ts';

const manual = { id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };

/** Execute checked-in, deterministic workflows against the installed package modules. */
export async function runN8nBaseCompatibilityProbe(packagesDirectory) {
	const registry = new NodeAdapterRegistry();
	const runtime = new N8nNodePackageRuntime(packagesDirectory);
	const discovery = await runtime.initialize(registry);
	if (!discovery.packages.includes('n8n-nodes-base')) throw new Error('n8n-nodes-base is not installed in SQUARED_N8N_PACKAGES_DIR');
	let controlledApiServerUrl = '';
	const updatedFixtureCredentials = new Map();
	const credentialProvider = async (reference, credentialType) => {
		if (updatedFixtureCredentials.has(reference.id)) return updatedFixtureCredentials.get(reference.id);
		if (credentialType === 'httpHeaderAuth' && reference.id === 'squared-fixture-credential') return { name: 'x-squared-token', value: 'fixture-token' };
		if (credentialType === 'githubApi' && reference.id === 'squared-github-credential') return { server: controlledApiServerUrl, accessToken: 'fixture-github-token' };
		if (credentialType === 'oAuth2Api' && reference.id === 'squared-oauth2-credential') return {
			clientId: 'fixture-client', clientSecret: 'fixture-secret', accessTokenUrl: `${controlledApiServerUrl}/oauth/token`,
			oauthTokenData: { access_token: 'expired-fixture-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', n8n_expires_at: 1 },
		};
		if (credentialType === 'oAuth1Api' && reference.id === 'squared-oauth1-credential') return {
			consumerKey: 'fixture-consumer', consumerSecret: 'fixture-consumer-secret',
			oauthTokenData: { oauth_token: 'fixture-access-token', oauth_token_secret: 'fixture-access-secret' },
		};
		return null;
	};
	credentialProvider.update = async (reference, credentialType, _node, credentials) => {
		updatedFixtureCredentials.set(reference.id, structuredClone(credentials));
	};
	const engine = new GraphExecutionEngine(registry, credentialProvider);
	const executions = [];
	const execute = async (test, nodeType, typeVersion, workflow, input, expected) => {
		const result = await engine.execute(workflow, { input });
		assert.equal(result.status, 'succeeded', result.error);
		if (expected.output) assert.deepEqual(result.output.map((item) => item.json), expected.output);
		if (expected.binary) assert.deepEqual(result.output.map((item) => item.binary ?? {}), expected.binary);
		if (expected.outputsByNode) {
			for (const [name, ports] of Object.entries(expected.outputsByNode)) {
				assert.deepEqual(result.outputsByNode[name].map((port) => port.map((item) => item.json)), ports);
			}
		}
		expected.assertResult?.(result);
		runtime.catalog.markValidatedWithEvidence(nodeType, {
			typeVersion,
			test,
			operation: describeOperation(workflow, nodeType),
			contracts: runtime.getSnapshot().nodes.find((node) => node.nodeType === nodeType)?.interfacesUsed ?? [],
			expected: { status: 'succeeded', output: expected.output, binary: expected.binary, result: expected.resultDescription },
			observed: { status: result.status, output: result.output.map((item) => item.json), binary: result.output.map((item) => item.binary ?? {}) },
			status: 'passed',
		});
		executions.push({ nodeType, typeVersion, test, status: 'passed', output: result.output, outputsByNode: result.outputsByNode, nodeRuns: result.nodeRuns });
		return result;
	};
	const executeExpectedError = async (test, nodeType, typeVersion, workflow, input, expectedMessage) => {
		const result = await engine.execute(workflow, { input });
		assert.equal(result.status, 'failed', 'The original node should fail this deterministic fixture');
		assert.match(String(result.error), new RegExp(expectedMessage));
		runtime.catalog.markExecutable(nodeType);
		runtime.catalog.markValidatedWithEvidence(nodeType, {
			typeVersion,
			test,
			operation: describeOperation(workflow, nodeType),
			contracts: runtime.getSnapshot().nodes.find((node) => node.nodeType === nodeType)?.interfacesUsed ?? [],
			expected: { status: 'failed', errorIncludes: expectedMessage },
			observed: { status: result.status, error: String(result.error) },
			status: 'passed',
		});
		executions.push({ nodeType, typeVersion, test, status: 'passed', observedStatus: result.status, error: String(result.error), nodeRuns: result.nodeRuns });
	};

	await execute('Set v3.5 expression and keep input fields', 'n8n-nodes-base.set', 3.5, {
		name: 'Published Set v3.5',
		nodes: [manual, {
			id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.5,
			parameters: { mode: 'manual', assignments: { assignments: [{ id: 'assignment-1', name: 'result', value: '={{$json.value}}', type: 'string' }] }, includeOtherFields: true, options: {} },
		}],
		connections: { Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
	}, { value: 'from-input', keep: 7 }, { output: [{ value: 'from-input', keep: 7, result: 'from-input' }] });

	await execute('Set v1 expression and keep input fields', 'n8n-nodes-base.set', 1, {
		name: 'Published Set v1',
		nodes: [manual, {
			id: 'set-v1', name: 'Set v1', type: 'n8n-nodes-base.set', typeVersion: 1,
			parameters: { keepOnlySet: false, values: { string: [{ name: 'legacyResult', value: '={{$json.value}}' }] }, options: {} },
		}],
		connections: { Manual: { main: [[{ node: 'Set v1', type: 'main', index: 0 }]] } },
	}, { value: 'version-one', keep: 8 }, { output: [{ value: 'version-one', keep: 8, legacyResult: 'version-one' }] });

	const ifNode = {
		id: 'if', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2.3,
		parameters: {
			conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 }, conditions: [{ leftValue: '={{$json.allow}}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
			options: {},
		},
	};
	await execute('If v2.3 true and false outputs', 'n8n-nodes-base.if', 2.3, {
		name: 'Published If v2.3',
		nodes: [manual, ifNode,
			{ id: 'true', name: 'True', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
			{ id: 'false', name: 'False', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'If', type: 'main', index: 0 }]] }, If: { main: [[{ node: 'True', type: 'main', index: 0 }], [{ node: 'False', type: 'main', index: 0 }]] } },
	}, [{ json: { allow: true } }, { json: { allow: false } }], { output: [{ allow: true }, { allow: false }], outputsByNode: { If: [[{ allow: true }], [{ allow: false }]] } });

	await execute('Filter v2.3 true and false outputs', 'n8n-nodes-base.filter', 2.3, {
		name: 'Published Filter v2.3',
		nodes: [manual, {
			id: 'filter', name: 'Filter', type: 'n8n-nodes-base.filter', typeVersion: 2.3,
			parameters: { conditions: ifNode.parameters.conditions, options: {} },
		},
		{ id: 'kept', name: 'Kept', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		{ id: 'discarded', name: 'Discarded', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }, Filter: { main: [[{ node: 'Kept', type: 'main', index: 0 }], [{ node: 'Discarded', type: 'main', index: 0 }]] } },
	}, [{ json: { allow: true } }, { json: { allow: false } }], { output: [{ allow: true }, { allow: false }], outputsByNode: { Filter: [[{ allow: true }], [{ allow: false }]] } });

	const rules = [
		{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: '={{$json.status}}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
		{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: '={{$json.status}}', rightValue: 'inactive', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
	];
	await execute('Switch v3.3 rule outputs and fallback none', 'n8n-nodes-base.switch', 3.3, {
		name: 'Published Switch v3.3',
		nodes: [manual, {
			id: 'switch', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3.3,
			parameters: { mode: 'rules', rules: { values: rules }, options: { fallbackOutput: 'none' } },
		},
		{ id: 'active', name: 'Active', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		{ id: 'inactive', name: 'Inactive', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'Switch', type: 'main', index: 0 }]] }, Switch: { main: [[{ node: 'Active', type: 'main', index: 0 }], [{ node: 'Inactive', type: 'main', index: 0 }]] } },
	}, [{ json: { status: 'active' } }, { json: { status: 'inactive' } }, { json: { status: 'pending' } }], { output: [{ status: 'active' }, { status: 'inactive' }], outputsByNode: { Switch: [[{ status: 'active' }], [{ status: 'inactive' }]] } });

	await execute('NoOp v1 passes items unchanged', 'n8n-nodes-base.noOp', 1, {
		name: 'Published NoOp v1',
		nodes: [manual, { id: 'no-op', name: 'No Operation', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }],
		connections: { Manual: { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] } },
	}, { untouched: true }, { output: [{ untouched: true }] });

	await execute('Code v2 runs a published JavaScript sandbox job over linked input items', 'n8n-nodes-base.code', 2, {
		name: 'Published Code v2',
		nodes: [manual, { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {
			mode: 'runOnceForAllItems',
			language: 'javaScript',
			jsCode: 'return $input.all().map(item => ({ json: { ...item.json, processed: true } }));',
		} }],
		connections: { Manual: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1, processed: true }, { id: 2, processed: true }] });

	await execute('Code v2 runs a published JavaScript sandbox job once for each input item', 'n8n-nodes-base.code', 2, {
		name: 'Published Code v2 each item',
		nodes: [manual, { id: 'code-each', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {
			mode: 'runOnceForEachItem',
			language: 'javaScript',
			jsCode: 'return { json: { ...$json, processed: true } };',
		} }],
		connections: { Manual: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1, processed: true }, { id: 2, processed: true }] });

	await execute('Merge v3.2 appends items from two real input ports', 'n8n-nodes-base.merge', 3.2, {
		name: 'Published Merge v3.2 append',
		nodes: [manual, {
			id: 'merge', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3.2,
			parameters: { mode: 'append', numberInputs: 2 },
		}],
		connections: { Manual: { main: [[
			{ node: 'Merge', type: 'main', index: 0 },
			{ node: 'Merge', type: 'main', index: 1 },
		]] } },
	}, [{ json: { id: 'a' } }, { json: { id: 'b' } }], { output: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'b' }] });

	await execute('Merge v3.2 combines items from two real input ports by position', 'n8n-nodes-base.merge', 3.2, {
		name: 'Published Merge v3.2 combine by position',
		nodes: [manual,
			{ id: 'left', name: 'Left', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'leftValue', value: 'left', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'right', name: 'Right', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'rightValue', value: 'right', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'merge-position', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3.2, parameters: { mode: 'combine', combineBy: 'combineByPosition', options: {} } },
		],
		connections: {
			Manual: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
			Left: { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
			Right: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
		},
	}, { ignored: true }, { output: [{ leftValue: 'left', rightValue: 'right' }] });

	await executeWaitAndResume('timeInterval');
	await executeWaitAndResume('webhook');

	await execute('Limit v1 returns the configured first items', 'n8n-nodes-base.limit', 1, {
		name: 'Published Limit v1',
		nodes: [manual, { id: 'limit', name: 'Limit', type: 'n8n-nodes-base.limit', typeVersion: 1, parameters: { maxItems: 1, keep: 'firstItems' } }],
		connections: { Manual: { main: [[{ node: 'Limit', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1 }] });

	await execute('Sort v1 orders items using its declared field configuration', 'n8n-nodes-base.sort', 1, {
		name: 'Published Sort v1',
		nodes: [manual, { id: 'sort', name: 'Sort', type: 'n8n-nodes-base.sort', typeVersion: 1, parameters: { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: 'id', order: 'ascending' }] }, options: {} } }],
		connections: { Manual: { main: [[{ node: 'Sort', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 2 } }, { json: { id: 1 } }], { output: [{ id: 1 }, { id: 2 }] });

	await execute('Remove Duplicates v2 removes repeated input items', 'n8n-nodes-base.removeDuplicates', 2, {
		name: 'Published Remove Duplicates v2',
		nodes: [manual, { id: 'dedupe', name: 'Remove Duplicates', type: 'n8n-nodes-base.removeDuplicates', typeVersion: 2, parameters: { operation: 'removeDuplicateInputItems', compare: 'allFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Remove Duplicates', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1 }, { id: 2 }] });

	await execute('Rename Keys v1 renames a configured JSON property', 'n8n-nodes-base.renameKeys', 1, {
		name: 'Published Rename Keys v1',
		nodes: [manual, { id: 'rename', name: 'Rename Keys', type: 'n8n-nodes-base.renameKeys', typeVersion: 1, parameters: { keys: { key: [{ currentKey: 'old', newKey: 'fresh' }] }, additionalOptions: {} } }],
		connections: { Manual: { main: [[{ node: 'Rename Keys', type: 'main', index: 0 }]] } },
	}, { old: 'value', keep: true }, { output: [{ fresh: 'value', keep: true }] });

	await execute('Split Out v1 expands an array while keeping other fields', 'n8n-nodes-base.splitOut', 1, {
		name: 'Published Split Out v1',
		nodes: [manual, { id: 'split', name: 'Split Out', type: 'n8n-nodes-base.splitOut', typeVersion: 1, parameters: { fieldToSplitOut: 'values', include: 'allOtherFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Split Out', type: 'main', index: 0 }]] } },
	}, { values: ['a', 'b'], keep: 7 }, { output: [{ keep: 7, values: 'a' }, { keep: 7, values: 'b' }] });

	await execute('Aggregate v1 groups a selected field into one item', 'n8n-nodes-base.aggregate', 1, {
		name: 'Published Aggregate v1',
		nodes: [manual, { id: 'aggregate', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, parameters: { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'value', renameField: false }] }, destinationFieldName: 'values', include: 'allFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] } },
	}, [{ json: { value: 1, group: 'a' } }, { json: { value: 2, group: 'b' } }], { output: [{ value: [1, 2] }] });

	await execute('Item Lists v3.1 executes the published splitOutItems operation', 'n8n-nodes-base.itemLists', 3.1, {
		name: 'Published Item Lists v3.1',
		nodes: [manual, { id: 'item-lists', name: 'Item Lists', type: 'n8n-nodes-base.itemLists', typeVersion: 3.1, parameters: { resource: 'itemList', operation: 'splitOutItems', fieldToSplitOut: 'values', include: 'allOtherFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Item Lists', type: 'main', index: 0 }]] } },
	}, { values: ['a', 'b'], keep: 7 }, { output: [{ keep: 7, values: 'a' }, { keep: 7, values: 'b' }] });

	await execute('Date & Time v2 formats a fixed date deterministically', 'n8n-nodes-base.dateTime', 2, {
		name: 'Published Date & Time v2',
		nodes: [manual, { id: 'date-time', name: 'Date & Time', type: 'n8n-nodes-base.dateTime', typeVersion: 2, parameters: { operation: 'formatDate', date: '2024-01-02T03:04:05.000Z', format: 'yyyy-MM-dd', outputFieldName: 'formattedDate', options: { includeInputFields: true } } }],
		connections: { Manual: { main: [[{ node: 'Date & Time', type: 'main', index: 0 }]] } },
	}, { tag: 'fixed' }, { output: [{ tag: 'fixed', formattedDate: '2024-01-02' }] });

	await execute('Crypto v2 hashes a fixed string with SHA-256', 'n8n-nodes-base.crypto', 2, {
		name: 'Published Crypto v2 SHA-256',
		nodes: [manual, { id: 'crypto', name: 'Crypto', type: 'n8n-nodes-base.crypto', typeVersion: 2, parameters: { action: 'hash', binaryData: false, value: 'hello', type: 'SHA256', encoding: 'hex', dataPropertyName: 'sha256' } }],
		connections: { Manual: { main: [[{ node: 'Crypto', type: 'main', index: 0 }]] } },
	}, { source: 'fixture' }, { output: [{ source: 'fixture', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }] });

	await execute('Convert to File v1.1 encodes a JSON string into real binary data', 'n8n-nodes-base.convertToFile', 1.1, {
		name: 'Published Convert to File v1.1',
		nodes: [manual, { id: 'convert-file', name: 'Convert to File', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, parameters: { operation: 'toText', sourceProperty: 'content', binaryPropertyName: 'file', options: { fileName: 'hello.txt', encoding: 'utf8' } } }],
		connections: { Manual: { main: [[{ node: 'Convert to File', type: 'main', index: 0 }]] } },
	}, { content: 'Hello' }, {
		output: [{}],
		binary: [{ file: { data: 'SGVsbG8=', fileName: 'hello.txt', fileExtension: 'txt', fileSize: '5 B', mimeType: 'text/plain', fileType: 'text' } }],
	});

	await execute('Extract from File v1.1 parses JSON from the binary data helper', 'n8n-nodes-base.extractFromFile', 1.1, {
		name: 'Published Extract from File v1.1 JSON',
		nodes: [manual, { id: 'extract-json', name: 'Extract from File', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1.1, parameters: { operation: 'fromJson', binaryPropertyName: 'data', destinationKey: 'parsed', options: { keepSource: 'json' } } }],
		connections: { Manual: { main: [[{ node: 'Extract from File', type: 'main', index: 0 }]] } },
	}, { json: { source: 'fixture' }, binary: { data: { data: Buffer.from('{"ok":true,"items":[1,2]}').toString('base64'), fileName: 'payload.json', fileExtension: 'json', mimeType: 'application/json' } } }, {
		output: [{ source: 'fixture', parsed: { ok: true, items: [1, 2] } }],
	});

	const compressedFixture = 'official compression binary fixture';
	await execute('Compression v1.1 compresses real binary data with gzip', 'n8n-nodes-base.compression', 1.1, {
		name: 'Published Compression v1.1 gzip',
		nodes: [manual, { id: 'compression', name: 'Compression', type: 'n8n-nodes-base.compression', typeVersion: 1.1, parameters: { operation: 'compress', binaryPropertyName: 'data', outputFormat: 'gzip', fileName: 'payload.gz', binaryPropertyOutput: 'compressed' } }],
		connections: { Manual: { main: [[{ node: 'Compression', type: 'main', index: 0 }]] } },
	}, { json: { keep: true }, binary: { data: { data: Buffer.from(compressedFixture).toString('base64'), fileName: 'payload.txt', fileExtension: 'txt', mimeType: 'text/plain' } } }, {
		output: [{ keep: true }],
		resultDescription: 'gunzip(compressed.binary.compressed) equals the input binary payload',
		assertResult(result) {
			const encoded = result.output[0]?.binary?.compressed?.data;
			assert.equal(typeof encoded, 'string');
			assert.equal(gunzipSync(Buffer.from(encoded, 'base64')).toString(), compressedFixture);
		},
	});

	await execute('Compression v1.1 decompresses gzip binary data and restores its bytes', 'n8n-nodes-base.compression', 1.1, {
		name: 'Published Compression v1.1 gunzip',
		nodes: [manual, { id: 'decompression', name: 'Compression', type: 'n8n-nodes-base.compression', typeVersion: 1.1, parameters: { operation: 'decompress', binaryPropertyName: 'data', outputPrefix: 'restored' } }],
		connections: { Manual: { main: [[{ node: 'Compression', type: 'main', index: 0 }]] } },
	}, { json: { keep: true }, binary: { data: { data: gzipSync(Buffer.from(compressedFixture)).toString('base64'), fileName: 'payload.txt.gz', fileExtension: 'gz', mimeType: 'application/gzip' } } }, {
		output: [{ keep: true }],
		resultDescription: 'gunzip output binary restored0 equals the original bytes',
		assertResult(result) {
			const encoded = result.output[0]?.binary?.restored0?.data;
			assert.equal(typeof encoded, 'string');
			assert.equal(Buffer.from(encoded, 'base64').toString(), compressedFixture);
		},
	});

	await execute('Spreadsheet File v2 reads deterministic CSV binary data into JSON items', 'n8n-nodes-base.spreadsheetFile', 2, {
		name: 'Published Spreadsheet File v2 CSV import',
		nodes: [manual, { id: 'spreadsheet', name: 'Spreadsheet File', type: 'n8n-nodes-base.spreadsheetFile', typeVersion: 2, parameters: { operation: 'fromFile', binaryPropertyName: 'data', fileFormat: 'csv', options: { headerRow: true } } }],
		connections: { Manual: { main: [[{ node: 'Spreadsheet File', type: 'main', index: 0 }]] } },
	}, { json: {}, binary: { data: { data: Buffer.from('name,age\nAda,37\nGrace,85\n').toString('base64'), fileName: 'people.csv', fileExtension: 'csv', mimeType: 'text/csv' } } }, {
		output: [{ name: 'Ada', age: '37' }, { name: 'Grace', age: '85' }],
	});

	await executeExpectedError('Stop and Error v1 propagates its configured workflow error', 'n8n-nodes-base.stopAndError', 1, {
		name: 'Published Stop and Error v1',
		nodes: [manual, { id: 'stop', name: 'Stop and Error', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, parameters: { errorType: 'errorMessage', errorMessage: 'intentional fixture error' } }],
		connections: { Manual: { main: [[{ node: 'Stop and Error', type: 'main', index: 0 }]] } },
	}, { source: 'fixture' }, 'intentional fixture error');

	await execute('Summarize v1.1 aggregates numeric input fields', 'n8n-nodes-base.summarize', 1.1, {
		name: 'Published Summarize v1.1',
		nodes: [manual, { id: 'summarize', name: 'Summarize', type: 'n8n-nodes-base.summarize', typeVersion: 1.1, parameters: { fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'amount' }] }, fieldsToSplitBy: '', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] } },
	}, [{ json: { amount: 3 } }, { json: { amount: 7 } }], { output: [{ sum_amount: 10 }] });

	await execute('Compare Datasets v2.3 joins two input ports and routes matching items', 'n8n-nodes-base.compareDatasets', 2.3, {
		name: 'Published Compare Datasets v2.3',
		nodes: [manual,
			{ id: 'set-a', name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'id', value: 1, type: 'number' }, { name: 'value', value: 'same', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'set-b', name: 'B', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'id', value: 1, type: 'number' }, { name: 'value', value: 'same', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'compare', name: 'Compare', type: 'n8n-nodes-base.compareDatasets', typeVersion: 2.3, parameters: { mergeByFields: { values: [{ field1: 'id', field2: 'id' }] }, resolve: 'includeBoth', options: {} } },
		],
		connections: {
			Manual: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'B', type: 'main', index: 0 }]] },
			A: { main: [[{ node: 'Compare', type: 'main', index: 0 }]] },
			B: { main: [[{ node: 'Compare', type: 'main', index: 1 }]] },
		},
	}, { ignored: true }, { output: [{ id: 1, value: 'same' }], outputsByNode: { Compare: [[], [{ id: 1, value: 'same' }], [], []] } });

	await execute('Convert to/from Binary Data v1 converts JSON bytes using the published node', 'n8n-nodes-base.moveBinaryData', 1, {
		name: 'Published Convert to Binary v1',
		nodes: [manual, { id: 'binary', name: 'Move Binary Data', type: 'n8n-nodes-base.moveBinaryData', typeVersion: 1, parameters: { mode: 'jsonToBinary', convertAllData: false, sourceKey: 'value', destinationKey: 'payload', options: { useRawData: true, mimeType: 'text/plain', fileName: 'payload.txt' } } }],
		connections: { Manual: { main: [[{ node: 'Move Binary Data', type: 'main', index: 0 }]] } },
	}, { value: 'hello', keep: true }, {
		output: [{ keep: true }],
		binary: [{ payload: { data: 'aGVsbG8=', fileName: 'payload.txt', fileExtension: 'txt', fileSize: '5 B', mimeType: 'text/plain', fileType: 'text' } }],
	});

	await execute('Convert to/from Binary Data v1 parses inline JSON binary data', 'n8n-nodes-base.moveBinaryData', 1, {
		name: 'Published Convert from Binary v1',
		nodes: [manual, { id: 'binary-json', name: 'Move Binary Data', type: 'n8n-nodes-base.moveBinaryData', typeVersion: 1, parameters: { mode: 'binaryToJson', setAllData: true, sourceKey: 'data', options: { encoding: 'utf8' } } }],
		connections: { Manual: { main: [[{ node: 'Move Binary Data', type: 'main', index: 0 }]] } },
	}, { json: {}, binary: { data: { data: Buffer.from('{"ok":true}').toString('base64'), mimeType: 'application/json', fileName: 'payload.json' } } }, {
		output: [{ ok: true }],
		binary: [{}],
	});

	await execute('XML v1 parses XML into a JSON object', 'n8n-nodes-base.xml', 1, {
		name: 'Published XML v1',
		nodes: [manual, { id: 'xml', name: 'XML', type: 'n8n-nodes-base.xml', typeVersion: 1, parameters: { mode: 'xmlToJson', dataPropertyName: 'data', options: {} } }],
		connections: { Manual: { main: [[{ node: 'XML', type: 'main', index: 0 }]] } },
	}, { data: '<root><name>Squared</name></root>' }, { output: [{ root: { name: 'Squared' } }] });

	await execute('HTML v1.2 extracts a CSS-selected text value', 'n8n-nodes-base.html', 1.2, {
		name: 'Published HTML v1.2',
		nodes: [manual, { id: 'html', name: 'HTML', type: 'n8n-nodes-base.html', typeVersion: 1.2, parameters: { operation: 'extractHtmlContent', sourceData: 'json', dataPropertyName: 'html', extractionValues: { values: [{ key: 'heading', cssSelector: 'h1', returnValue: 'text', returnArray: false }] }, options: { trimValues: true, cleanUpText: true } } }],
		connections: { Manual: { main: [[{ node: 'HTML', type: 'main', index: 0 }]] } },
	}, { html: '<main><h1>Squared</h1></main>' }, { output: [{ heading: 'Squared' }] });

	await execute('Markdown v1 converts HTML using the published converter', 'n8n-nodes-base.markdown', 1, {
		name: 'Published Markdown v1',
		nodes: [manual, { id: 'markdown', name: 'Markdown', type: 'n8n-nodes-base.markdown', typeVersion: 1, parameters: { mode: 'htmlToMarkdown', html: '<h1>Squared</h1><p>Hello <strong>world</strong></p>', destinationKey: 'markdown', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Markdown', type: 'main', index: 0 }]] } },
	}, { source: 'fixture' }, { output: [{ source: 'fixture', markdown: '# Squared\n\nHello **world**' }] });

	const fixtureServer = createServer(async (request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		if (url.pathname === '/feed.rss') {
			response.writeHead(200, { 'content-type': 'application/rss+xml' });
			response.end('<rss version="2.0"><channel><title>Squared fixture</title><link>https://example.test</link><description>Fixture feed</description><item><title>New event</title><link>https://example.test/new-event</link><guid>new-event</guid><pubDate>Fri, 01 Jan 2999 00:00:00 GMT</pubDate><description>Published fixture item</description></item></channel></rss>');
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		if (url.pathname === '/oauth/token') {
			let body = '';
			for await (const chunk of request) body += chunk;
			const params = new URLSearchParams(body);
			response.end(JSON.stringify(params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'fixture-refresh-token'
				? { access_token: 'fixture-refreshed-token', refresh_token: 'rotated-fixture-refresh-token', token_type: 'Bearer', expires_in: 3_600 }
				: { error: 'invalid_refresh_token' }));
			return;
		}
		response.end(JSON.stringify({
			method: request.method, path: url.pathname, query: url.searchParams.get('q'),
			headerCredentialAccepted: request.headers['x-squared-token'] === 'fixture-token',
			githubCredentialAccepted: request.headers.authorization === 'token fixture-github-token',
			oauthCredentialAccepted: request.headers.authorization === 'Bearer fixture-refreshed-token',
			oauth1CredentialAccepted: typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('OAuth ') && request.headers.authorization.includes('oauth_consumer_key="fixture-consumer"'),
		}));
	});
	await new Promise((resolve, reject) => {
		fixtureServer.once('error', reject);
		fixtureServer.listen(0, '127.0.0.1', resolve);
	});
	try {
		const address = fixtureServer.address();
		if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind to an ephemeral port');
		controlledApiServerUrl = `http://127.0.0.1:${address.port}`;
		await execute('HTTP Request v4.5 to local controlled JSON fixture', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request v4.5',
			nodes: [manual, {
				id: 'http', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/fixture?q=local`, authentication: 'none', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/fixture', query: 'local', headerCredentialAccepted: false, githubCredentialAccepted: false, oauthCredentialAccepted: false, oauth1CredentialAccepted: false }] });
		await execute('HTTP Request v4.5 applies a real HttpHeaderAuth credential', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request with Header Auth',
			nodes: [manual, {
				id: 'http-auth', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/fixture`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
				credentials: { httpHeaderAuth: { id: 'squared-fixture-credential', name: 'Fixture Header' } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/fixture', query: null, headerCredentialAccepted: true, githubCredentialAccepted: false, oauthCredentialAccepted: false, oauth1CredentialAccepted: false }] });
		await execute('HTTP Request v4.5 refreshes and persists an expired OAuth2 token', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request with OAuth2 refresh fixture',
			nodes: [manual, {
				id: 'http-oauth2', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/oauth-resource`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
				credentials: { oAuth2Api: { id: 'squared-oauth2-credential', name: 'Fixture OAuth2' } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/oauth-resource', query: null, headerCredentialAccepted: false, githubCredentialAccepted: false, oauthCredentialAccepted: true, oauth1CredentialAccepted: false }] });
		assert.equal(updatedFixtureCredentials.get('squared-oauth2-credential')?.oauthTokenData?.refresh_token, 'rotated-fixture-refresh-token');
		await execute('HTTP Request v4.5 signs a request with the published OAuth1 credential', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request with OAuth1 fixture',
			nodes: [manual, {
				id: 'http-oauth1', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/oauth1-resource`, authentication: 'genericCredentialType', genericAuthType: 'oAuth1Api', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
				credentials: { oAuth1Api: { id: 'squared-oauth1-credential', name: 'Fixture OAuth1' } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/oauth1-resource', query: null, headerCredentialAccepted: false, githubCredentialAccepted: false, oauthCredentialAccepted: false, oauth1CredentialAccepted: true }] });
		await execute('GitHub repository:get uses the published node and GithubApi credential against the local fixture', 'n8n-nodes-base.github', 1, {
			name: 'Published GitHub repository:get with a controlled API endpoint',
			nodes: [manual, {
				id: 'github', name: 'GitHub', type: 'n8n-nodes-base.github', typeVersion: 1,
				parameters: { authentication: 'accessToken', resource: 'repository', operation: 'get', owner: { mode: 'name', value: 'squared' }, repository: { mode: 'name', value: 'fixture' } },
				credentials: { githubApi: { id: 'squared-github-credential', name: 'Fixture GitHub API' } },
			}],
			connections: { Manual: { main: [[{ node: 'GitHub', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/repos/squared/fixture', query: null, headerCredentialAccepted: false, githubCredentialAccepted: true, oauthCredentialAccepted: false, oauth1CredentialAccepted: false }] });
		const pollWorkflow = {
			id: 'squared-compatibility-rss-poll', name: 'Published RSS Feed Trigger poll',
			nodes: [
				{ id: 'rss-trigger', name: 'RSS Feed', type: 'n8n-nodes-base.rssFeedReadTrigger', typeVersion: 1, parameters: { feedUrl: `${controlledApiServerUrl}/feed.rss` } },
				{ id: 'rss-noop', name: 'After RSS', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
			],
			connections: { 'RSS Feed': { main: [[{ node: 'After RSS', type: 'main', index: 0 }]] } },
		};
		const firstPoll = await engine.execute(pollWorkflow, { mode: 'poll', startNode: 'RSS Feed', staticData: { 'node:rss-trigger': { lastItemDate: '2998-01-01T00:00:00.000Z' } } });
		assert.equal(firstPoll.status, 'succeeded', firstPoll.error);
		assert.deepEqual(firstPoll.output.map((item) => ({ title: item.json.title, link: item.json.link })), [{ title: 'New event', link: 'https://example.test/new-event' }]);
		assert.equal(firstPoll.staticData['node:rss-trigger'].lastItemDate, '2999-01-01T00:00:00.000Z');
		const repeatedPoll = await engine.execute(pollWorkflow, { mode: 'poll', startNode: 'RSS Feed', staticData: firstPoll.staticData });
		assert.equal(repeatedPoll.status, 'succeeded', repeatedPoll.error);
		assert.deepEqual(repeatedPoll.output, []);
		runtime.catalog.markValidatedWithEvidence('n8n-nodes-base.rssFeedReadTrigger', {
			typeVersion: 1, test: 'RSS Feed Trigger v1 polls a local RSS feed and persists its last item date',
			operation: 'poll:feedUrl', contracts: ['IPollFunctions', 'IExecuteFunctions.helpers.httpRequest', 'IExecuteFunctions.getWorkflowStaticData'],
			expected: { firstPollTitles: ['New event'], secondPollOutputItems: 0, persistedLastItemDate: '2999-01-01T00:00:00.000Z' },
			observed: { firstPollTitles: firstPoll.output.map((item) => item.json.title), secondPollOutputItems: repeatedPoll.output.length, persistedLastItemDate: firstPoll.staticData['node:rss-trigger'].lastItemDate }, status: 'passed',
		});
		executions.push({ nodeType: 'n8n-nodes-base.rssFeedReadTrigger', typeVersion: 1, test: 'RSS Feed Trigger v1 polls a local RSS feed and persists its last item date', status: 'passed', output: firstPoll.output, nodeRuns: firstPoll.nodeRuns });
	} finally {
		await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
	}

	const webhookWorkflow = {
		id: 'squared-compatibility-webhook-fixture',
		name: 'Published Webhook v1.1 fixture',
		nodes: [
			{ id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1.1, parameters: { httpMethod: 'POST', path: 'fixture-hook', responseMode: 'onReceived', options: { responseData: 'Fixture accepted' } } },
			{ id: 'after-webhook', name: 'After Webhook', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Webhook: { main: [[{ node: 'After Webhook', type: 'main', index: 0 }]] } },
	};
	const webhookRequest = {
		method: 'POST', url: 'http://127.0.0.1/webhook/squared-compatibility-webhook-fixture', path: '/webhook/squared-compatibility-webhook-fixture',
		headers: { 'content-type': 'application/json' }, query: { source: 'fixture' },
		body: { event: 'node-runtime' }, params: {}, rawBody: Buffer.from('{"event":"node-runtime"}'),
		contentType: 'application/json', ip: '127.0.0.1', ips: ['127.0.0.1'], readRawBody: async () => Buffer.from('{"event":"node-runtime"}'),
	};
	const preparedWebhook = await engine.prepareWebhook(webhookWorkflow, 'Webhook', webhookRequest);
	assert.equal(preparedWebhook.result.webhookResponse, 'Fixture accepted');
	const webhookExecution = await engine.execute(webhookWorkflow, { mode: 'webhook', startNode: 'Webhook', initialOutput: preparedWebhook.result.workflowData });
	assert.equal(webhookExecution.status, 'succeeded', webhookExecution.error);
	assert.deepEqual(webhookExecution.output[0]?.json, {
		headers: { 'content-type': 'application/json' }, params: {}, query: { source: 'fixture' }, body: { event: 'node-runtime' },
		webhookUrl: webhookRequest.url, executionMode: 'production',
	});
	let webhookActive = true;
	const routeService = new WorkflowService(
		{ async listWorkflows() { return [{ ...webhookWorkflow, active: webhookActive }]; } },
		{ async reconcileTriggers() { return 0; } },
		runtime,
		credentialProvider,
	);
	await routeService.reconcileWebhooks();
	const registeredPath = '/webhook/squared-compatibility-webhook-fixture/webhook/fixture-hook';
	assert.equal(routeService.resolveWebhook('POST', registeredPath)?.nodeName, 'Webhook');
	webhookActive = false;
	const remainingRoutes = await routeService.reconcileWebhooks();
	runtime.catalog.markValidatedWithEvidence('n8n-nodes-base.webhook', {
		typeVersion: 1.1, test: 'activation registers the official Webhook path and deactivation removes it',
		operation: 'register/delete:POST /webhook/{workflowId}/webhook/fixture-hook',
		contracts: ['INodeTypeDescription.webhooks', 'IPollFunctions/webhook activation registry'],
		expected: { registered: true, removedAfterDeactivation: true },
		observed: { registered: true, removedAfterDeactivation: remainingRoutes === 0 }, status: 'passed',
	});
	assert.equal(remainingRoutes, 0);
	assert.equal(routeService.resolveWebhook('POST', registeredPath), null);
	executions.push({ nodeType: 'n8n-nodes-base.webhook', typeVersion: 1.1, test: 'activation registers the official Webhook path and deactivation removes it', status: 'passed', registeredPath, removedAfterDeactivation: true });
	runtime.catalog.markValidatedWithEvidence('n8n-nodes-base.webhook', {
		typeVersion: 1.1, test: 'Webhook v1.1 POST body and query reach the real downstream execution',
		operation: 'webhook:POST', contracts: ['IWebhookFunctions', 'IExecuteFunctions.getRequestObject', 'IExecuteFunctions.getBodyData', 'IExecuteFunctions.getQueryData'],
		expected: { status: 'succeeded', webhookResponse: 'Fixture accepted', body: webhookRequest.body, query: webhookRequest.query },
		observed: { status: webhookExecution.status, webhookResponse: preparedWebhook.result.webhookResponse, output: webhookExecution.output.map((item) => item.json) }, status: 'passed',
	});
	executions.push({ nodeType: 'n8n-nodes-base.webhook', typeVersion: 1.1, test: 'Webhook v1.1 POST body and query reach the real downstream execution', status: 'passed', output: webhookExecution.output, nodeRuns: webhookExecution.nodeRuns });

	return {
		packages: discovery.packages,
		nodesDiscovered: discovery.nodes.length,
		executions,
		nodes: runtime.getSnapshot().nodes,
		credentials: runtime.getSnapshot().credentials,
	};

	async function executeWaitAndResume(resumeMode) {
		const workflow = {
			id: `squared-compatibility-wait-${resumeMode}`,
			name: `Published Wait v1.1 ${resumeMode} resume`,
			nodes: [manual, {
				id: 'wait', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1,
				parameters: resumeMode === 'webhook' ? { resume: 'webhook', options: {} } : { resume: 'timeInterval', amount: 0, unit: 'seconds' },
			}, {
				id: 'noop-after-wait', name: 'After Wait', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {},
			}],
			connections: {
				Manual: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
				Wait: { main: [[{ node: 'After Wait', type: 'main', index: 0 }]] },
			},
		};
		const workflows = new Map([[workflow.id, workflow]]);
		const executionsById = new Map();
		const waitStates = new Map();
		const staticData = new Map();
		const store = {
			async getWorkflow(id) { return workflows.get(id) ?? null; },
			async getWorkflowRuntimeState(id) { return staticData.get(id) ?? {}; },
			async saveWorkflowRuntimeState(id, state) { staticData.set(id, state); },
			async createExecution(execution) { executionsById.set(execution.id, { ...execution, status: 'queued' }); },
			async getWaitingExecution(id) {
				return waitStates.has(id) ? { ...executionsById.get(id), waitState: waitStates.get(id) } : null;
			},
			async startExecution(id) { executionsById.get(id).status = 'running'; waitStates.delete(id); },
			async suspendExecution(id, waitState) { executionsById.get(id).status = 'waiting'; waitStates.set(id, waitState); },
			async listDueWaitingExecutions(now) {
				return [...waitStates].filter(([, waitState]) => waitState.resumeAt && Date.parse(waitState.resumeAt) <= now)
					.map(([id, waitState]) => ({ ...executionsById.get(id), waitState }));
			},
			async finishExecution(id, output) { Object.assign(executionsById.get(id), { status: 'succeeded', output }); },
			async failExecution(id, error) { Object.assign(executionsById.get(id), { status: 'failed', error: String(error) }); },
		};
		const queue = new ExecutionEngine({ store, registry: new Map(), graphEngine: engine, concurrency: 1, maxQueued: 2 });
		const queued = await queue.submit(workflow, 'manual', { resumed: true });
		await queue.drain();
		assert.equal(executionsById.get(queued.id).status, 'waiting', executionsById.get(queued.id).error);
		assert.equal(waitStates.get(queued.id).nodeName, 'Wait');
		if (resumeMode === 'webhook') {
			assert.equal(waitStates.get(queued.id).acceptsResumeRequest, true);
			await queue.resumeWaitingExecution(queued.id, { resumedBy: 'manual-request' });
		} else {
			assert.equal(waitStates.get(queued.id).acceptsResumeRequest, false);
			await queue.resumeDueWaits(Date.now() + 1_000);
		}
		await queue.drain();
		const completed = executionsById.get(queued.id);
		assert.equal(completed.status, 'succeeded', completed.error);
		const expectedOutput = resumeMode === 'webhook' ? { resumedBy: 'manual-request' } : { resumed: true };
		assert.deepEqual(completed.output.output.map((item) => item.json), [expectedOutput]);
		const type = 'n8n-nodes-base.wait';
		runtime.catalog.markValidatedWithEvidence(type, {
			typeVersion: 1.1,
			test: `Wait v1.1 stores and resumes a deterministic execution with resume=${resumeMode}`,
			operation: `resume=${resumeMode}`,
			contracts: runtime.getSnapshot().nodes.find((node) => node.nodeType === type)?.interfacesUsed ?? [],
			expected: { firstStatus: 'waiting', resumedStatus: 'succeeded', output: [expectedOutput] },
			observed: { firstStatus: 'waiting', resumedStatus: completed.status, output: completed.output.output.map((item) => item.json) },
			status: 'passed',
		});
		executions.push({ nodeType: type, typeVersion: 1.1, test: `Wait v1.1 stores and resumes a deterministic execution with resume=${resumeMode}`, status: 'passed', firstStatus: 'waiting', resumedStatus: completed.status });
	}
}

function describeOperation(workflow, nodeType) {
	const node = workflow.nodes.find((candidate) => candidate.type === nodeType);
	const parameters = node?.parameters ?? {};
	const operationParameters = ['resource', 'operation', 'mode', 'combineBy', 'action', 'command']
		.filter((name) => parameters[name] !== undefined)
		.map((name) => `${name}=${parameters[name]}`);
	return operationParameters.length ? operationParameters.join(';') : 'default';
}
