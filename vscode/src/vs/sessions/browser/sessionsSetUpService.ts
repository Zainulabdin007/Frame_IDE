/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { DeferredPromise } from '../../base/common/async.js';
import { createDecorator, IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IUserDataProfileStorageService } from '../../platform/userDataProfile/common/userDataProfileStorageService.js';
import { IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ChatEntitlementContext, IChatEntitlementService } from '../../workbench/services/chat/common/chatEntitlementService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { WELCOME_COMPLETE_KEY } from '../common/welcome.js';

const AIDisabledConfig = 'chat.disableAIFeatures';

export const ISessionsSetUpService = createDecorator<ISessionsSetUpService>('sessionsSetUpService');

export interface ISessionsSetUpService {
	readonly _serviceBrand: undefined;
	/**
	 * Resolves when the welcome/setup flow has completed (or immediately
	 * if it is not currently active). Use this to defer work until after
	 * the user has finished the initial sign-in or setup dialog.
	 */
	whenWelcomeDone(): Promise<void>;
}

/**
 * Frame: fully local product — never show Microsoft/GitHub sign-in welcome.
 * Completes setup immediately so residual Agents/Chat paths do not block Frame AI.
 */
class SessionsSetUpWidget extends Disposable {

	constructor(
		private readonly onCompleted: () => void,
		_serviceWhenSetupDone: () => Promise<boolean>,
		private readonly serviceMarkDone: () => void,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._start();
	}

	private _start(): void {
		this.logService.info('[Frame] Skipping sessions welcome sign-in (local Frame AI)');
		this.storageService.store(WELCOME_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		void this.configurationService.updateValue(AIDisabledConfig, false);
		this.serviceMarkDone();
		this.onCompleted();
	}
}

export class SessionsSetUpService extends Disposable implements ISessionsSetUpService {

	declare readonly _serviceBrand: undefined;

	private readonly _initPromise: Promise<void>;
	private readonly _welcomeDoneDeferred = new DeferredPromise<void>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IUserDataProfileStorageService private readonly userDataProfileStorageService: IUserDataProfileStorageService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._initPromise = this.initialize();

		this._register(this.instantiationService.createInstance(
			SessionsSetUpWidget,
			() => this._welcomeDoneDeferred.complete(),
			() => this.whenSetupDone(),
			() => this.markDone()
		));
	}

	private async whenSetupDone(): Promise<boolean> {
		await this._initPromise;
		return this.chatEntitlementService.sentiment.completed === true;
	}

	private markDone(): void {
		this.chatEntitlementService.markSetupCompleted();
	}

	whenWelcomeDone(): Promise<void> {
		return this._welcomeDoneDeferred.p;
	}

	private async initialize(): Promise<void> {
		if (this.chatEntitlementService.sentiment.completed) {
			return;
		}

		try {
			const defaultProfile = this.userDataProfilesService.defaultProfile;
			await this.userDataProfileStorageService.withProfileScopedStorageService(defaultProfile, async storageService => {
				const defaultContext = this.instantiationService
					.createChild(new ServiceCollection([IStorageService, storageService]))
					.createInstance(ChatEntitlementContext);
				try {
					if (defaultContext.state.completed) {
						this.logService.info('[sessions welcome] Setup already completed in default profile, marking done locally');
						this.markDone();
					}
				} finally {
					defaultContext.dispose();
				}
			});
		} catch (error) {
			this.logService.error('[sessions welcome] Failed to read setup state from default profile:', error);
		}
	}
}
