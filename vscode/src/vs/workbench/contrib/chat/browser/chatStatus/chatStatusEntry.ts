/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatStatus.css';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { ChatEntitlement, ChatEntitlementContextKeys, ChatEntitlementService, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { disposableLongTimeout } from '../../../../../base/common/async.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { getCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IInlineCompletionsService } from '../../../../../editor/browser/services/inlineCompletionsService.js';

import product from '../../../../../platform/product/common/product.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { InEditorZenModeContext } from '../../../../common/contextkeys.js';
import { ChatConfiguration } from '../../common/constants.js';

/**
 * Tracks whether Copilot is currently blocked by a reached quota limit, has
 * resumed after a limit reset, or neither. Persisted across sessions so a reset
 * that happens while VS Code is closed can still be surfaced on next launch.
 */
export type ChatQuotaResumeState = 'none' | 'blocked' | 'resumed';

type ChatQuotas = IChatEntitlementService['quotas'];

/**
 * Whether this entry tracks quota for the given entitlement. All signed-up plans
 * are tracked via the unified premium chat quota. Transient states (signed out,
 * unresolved, not entitled) are not tracked.
 */
function isTrackedEntitlement(entitlement: ChatEntitlement): boolean {
	switch (entitlement) {
		case ChatEntitlement.Free:
		case ChatEntitlement.EDU:
		case ChatEntitlement.Pro:
		case ChatEntitlement.ProPlus:
		case ChatEntitlement.Business:
		case ChatEntitlement.Enterprise:
			return true;
		default:
			return false;
	}
}

function isQuotaBlocked(quotas: ChatQuotas): boolean {
	const premiumChat = quotas.premiumChat;
	if (premiumChat === undefined) {
		return false;
	}

	return premiumChat.unlimited ? premiumChat.hasQuota === false : premiumChat.percentRemaining === 0;
}

function hasResolvedQuota(quotas: ChatQuotas): boolean {
	return quotas.premiumChat !== undefined;
}

/**
 * Pure state transition for Frame AI quota "resumed" indicator:
 * - Enters `blocked` while a limit is reached and the user is not on additional spend.
 * - Moves `blocked` -> `resumed` only on a genuine limit reset (fresh quota, no additional spend).
 * - Moves `blocked` -> `none` when unblocked via additional spend (not a reset).
 * - Keeps `blocked` while fresh quota has not been resolved yet (e.g. offline) to avoid false positives.
 * - Otherwise preserves the previous state, so `resumed` persists until dismissed.
 * - Resets to `none` for entitlements this entry doesn't track, so the state can't get stuck (e.g. upgrading from Free while `blocked`).
 */
export function computeQuotaResumeState(previous: ChatQuotaResumeState, entitlement: ChatEntitlement, quotas: ChatQuotas): ChatQuotaResumeState {
	if (!isTrackedEntitlement(entitlement)) {
		return 'none';
	}

	const additionalSpend = quotas.additionalUsageEnabled === true;

	if (!additionalSpend && isQuotaBlocked(quotas)) {
		return 'blocked';
	}

	if (previous !== 'blocked') {
		return previous;
	}

	if (additionalSpend) {
		return 'none';
	}

	return hasResolvedQuota(quotas) ? 'resumed' : 'blocked';
}

export class ChatStatusBarEntry extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatStatusBarEntry';

	private static readonly TITLE_BAR_CONTEXT_KEYS = new Set(['updateTitleBar', InEditorZenModeContext.key, ChatEntitlementContextKeys.hasByokModels.key]);

	private static readonly QUOTA_RESUME_STATE_KEY = 'chat.quotaResumeState';
	private static readonly QUOTA_RESET_RETRY_DELAY = 5 * 60 * 1000; // re-check 5 min after a passed reset time

	private entry: IStatusbarEntryAccessor | undefined = undefined;

	private readonly activeCodeEditorListener = this._register(new MutableDisposable());

	private quotaResumeState: ChatQuotaResumeState;
	private readonly quotaResetTimer = this._register(new MutableDisposable());
	private readonly quotaRefresh = this._register(new MutableDisposable());

	constructor(
		@IChatEntitlementService private readonly chatEntitlementService: ChatEntitlementService,
		@IStatusbarService _statusbarService: IStatusbarService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInlineCompletionsService private readonly completionsService: IInlineCompletionsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.quotaResumeState = this.readPersistedQuotaResumeState();

		this.update();

		this.registerListeners();

		this.initializeQuotaResumeState();
	}

	private update(): void {
		// Frame: never show Frame AI status-bar entry or its sign-in/upgrade dashboard.
		this.entry?.dispose();
		this.entry = undefined;
	}

	private registerListeners(): void {
		this._register(this.chatEntitlementService.onDidChangeQuotaExceeded(() => this.onQuotaChanged()));
		this._register(this.chatEntitlementService.onDidChangeQuotaRemaining(() => this.onQuotaChanged()));
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => this.update()));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => this.onQuotaChanged()));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(ChatStatusBarEntry.TITLE_BAR_CONTEXT_KEYS)) {
				this.update();
			}
		}));

		this._register(this.completionsService.onDidChangeIsSnoozing(() => this.update()));

		this._register(this.editorService.onDidActiveEditorChange(() => this.onDidActiveEditorChange()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(product.defaultChatAgent?.completionsEnablementSetting) || e.affectsConfiguration(ChatConfiguration.TitleBarSignInEnabled)) {
				this.update();
			}
		}));
	}

	private onDidActiveEditorChange(): void {
		this.update();

		this.activeCodeEditorListener.clear();

		// Listen to language changes in the active code editor
		const activeCodeEditor = getCodeEditor(this.editorService.activeTextEditorControl);
		if (activeCodeEditor) {
			this.activeCodeEditorListener.value = activeCodeEditor.onDidChangeModelLanguage(() => {
				this.update();
			});
		}
	}

	//#region --- Quota Resume Tracking

	private onQuotaChanged(): void {
		this.evaluateQuotaResumeState();
		this.update();
	}

	private evaluateQuotaResumeState(): void {
		const next = computeQuotaResumeState(this.quotaResumeState, this.chatEntitlementService.entitlement, this.chatEntitlementService.quotas);
		this.setQuotaResumeState(next);

		// While blocked, schedule a refresh for when the limit is expected to reset.
		if (next === 'blocked') {
			this.scheduleQuotaResetRefresh();
		} else {
			this.quotaResetTimer.clear();
		}
	}

	private getQuotaResetTime(): number | undefined {
		const quotas = this.chatEntitlementService.quotas;

		const premiumResetAt = quotas.premiumChat?.resetAt;
		if (typeof premiumResetAt === 'number') {
			return premiumResetAt * 1000;
		}

		if (quotas.resetDate) {
			const parsed = Date.parse(quotas.resetDate);
			if (!isNaN(parsed)) {
				return parsed;
			}
		}

		return undefined;
	}

	private scheduleQuotaResetRefresh(): void {
		const resetAt = this.getQuotaResetTime();
		if (resetAt === undefined) {
			this.quotaResetTimer.clear(); // no known reset time: rely on quota events and next launch
			return;
		}

		// Back off when the reset time has already passed but we are still blocked,
		// so we re-check periodically instead of hammering the service.
		const delay = resetAt > Date.now() ? resetAt - Date.now() : ChatStatusBarEntry.QUOTA_RESET_RETRY_DELAY;
		this.quotaResetTimer.value = disposableLongTimeout(() => this.refreshQuotaAndEvaluate(), delay);
	}

	private refreshQuotaAndEvaluate(): void {
		const cts = new CancellationTokenSource();
		this.quotaRefresh.value = toDisposable(() => cts.dispose(true));

		(async () => {
			try {
				await this.chatEntitlementService.update(cts.token);
			} catch {
				// Ignore refresh failures: keep the last known state and let a future
				// quota update or the next launch re-evaluate.
			}

			if (cts.token.isCancellationRequested) {
				return;
			}

			this.evaluateQuotaResumeState();
			this.update();
		})();
	}

	private initializeQuotaResumeState(): void {
		if (this.quotaResumeState === 'blocked') {
			// A blocked state was recorded in a previous session: verify against fresh
			// quota data whether the limit has since reset while VS Code was closed.
			this.refreshQuotaAndEvaluate();
		} else {
			this.evaluateQuotaResumeState();
		}
	}

	private readPersistedQuotaResumeState(): ChatQuotaResumeState {
		const stored = this.storageService.get(ChatStatusBarEntry.QUOTA_RESUME_STATE_KEY, StorageScope.PROFILE);
		return stored === 'blocked' || stored === 'resumed' ? stored : 'none';
	}

	private setQuotaResumeState(state: ChatQuotaResumeState): void {
		if (this.quotaResumeState === state) {
			return;
		}

		this.quotaResumeState = state;
		if (state === 'none') {
			this.storageService.remove(ChatStatusBarEntry.QUOTA_RESUME_STATE_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(ChatStatusBarEntry.QUOTA_RESUME_STATE_KEY, state, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	//#endregion

	override dispose(): void {
		super.dispose();

		this.entry?.dispose();
		this.entry = undefined;
	}
}
