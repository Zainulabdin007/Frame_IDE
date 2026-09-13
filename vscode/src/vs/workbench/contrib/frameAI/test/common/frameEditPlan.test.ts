/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frame. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFrameInferenceContext } from '../../common/models.js';
import {
	isSuspiciousDestructiveModify,
	materializeSourceEdit,
	parseModelEditPlan,
	synthesizeRecoveredEditPlan,
} from '../../runtime/frameEditPlan.js';

suite('FrameEditPlan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const original = [
		'# Frame Memory Persistence',
		'',
		'Durable local memory.',
		'',
		'```json',
		'{"enabled":true}',
		'```',
		'',
		'More documentation.',
	].join('\n').repeat(20);

	const context = {
		activeRelativePath: 'FRAME_MEMORY_PERSISTENCE.md',
		activeFileContent: original,
	} as IFrameInferenceContext;

	test('recovers exact first-line additive request without deleting content', () => {
		const plan = synthesizeRecoveredEditPlan(
			'task',
			'can you add the word hello to the 1st line of that file',
			context,
			'I need to read the file.',
		);
		assert.ok(plan);
		const operation = plan.operations[0];
		assert.strictEqual(operation.kind, 'modify');
		assert.ok(operation.kind === 'modify');
		const materialized = materializeSourceEdit(original, operation.sourceEdit!);
		assert.ok(materialized.startsWith('hello # Frame Memory Persistence'));
		assert.ok(materialized.endsWith(original.slice(-100)));
		assert.ok(materialized.length > original.length);
	});

	test('inserts a word on the requested second line', () => {
		const plan = synthesizeRecoveredEditPlan(
			'task',
			'add the word hello on the second line of that file',
			context,
			'',
		);
		assert.ok(plan);
		const operation = plan.operations[0];
		assert.ok(operation.kind === 'modify');
		const materialized = materializeSourceEdit(original, operation.sourceEdit!);
		assert.strictEqual(materialized.split('\n')[1], 'hello');
		assert.ok(materialized.endsWith(original.slice(-100)));
	});

	test('normalizes concise append operation into a preserving modify', () => {
		const output = [
			'```frame-edit-plan',
			'{"summary":"Add summary","operations":[{"kind":"append","path":"FRAME_MEMORY_PERSISTENCE.md","content":"## Summary\\nLocal memory documentation."}]}',
			'```',
		].join('\n');
		const plan = parseModelEditPlan('task', 'add a summary at the bottom', context, output);
		assert.ok(plan);
		const operation = plan.operations[0];
		assert.strictEqual(operation.kind, 'modify');
		assert.ok(operation.kind === 'modify');
		assert.deepStrictEqual(operation.sourceEdit, {
			kind: 'append',
			content: '## Summary\nLocal memory documentation.',
		});
		const materialized = materializeSourceEdit(original, operation.sourceEdit!);
		assert.ok(materialized.startsWith(original));
		assert.ok(materialized.endsWith('## Summary\nLocal memory documentation.\n'));
	});

	test('parses plans whose file content contains markdown fences', () => {
		const newContent = `${original}\nhello`;
		const output = `\`\`\`frame-edit-plan\n${JSON.stringify({
			operations: [{ kind: 'modify', path: 'FRAME_MEMORY_PERSISTENCE.md', newContent }],
		})}\n\`\`\``;
		const plan = parseModelEditPlan('task', 'update file', context, output);
		assert.ok(plan);
		const operation = plan.operations[0];
		assert.ok(operation.kind === 'modify');
		assert.strictEqual(operation.newContent, newContent);
	});

	test('destructive-edit safeguard is disabled for local preview', () => {
		assert.strictEqual(
			isSuspiciousDestructiveModify('add hello to the second line', original, '# Frame Memory Persistence\nhello\n'),
			false,
		);
		assert.strictEqual(
			isSuspiciousDestructiveModify('add hello to the second line', original, `${original}\nhello`),
			false,
		);
	});
});
