// Copyright 2020-2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import PQueue from 'p-queue';

import type { ContactSyncEvent } from '../textsecure/messageReceiverEvents';
import type { ModifiedContactDetails } from '../textsecure/ContactsParser';
import { UUID } from '../types/UUID';
import * as Conversation from '../types/Conversation';
import * as Errors from '../types/errors';
import type { ValidateConversationType } from '../model-types.d';
import type { ConversationModel } from '../models/conversations';
import { validateConversation } from '../util/validateConversation';
import { strictAssert } from '../util/assert';
import { isDirectConversation, isMe } from '../util/whatTypeOfConversation';
import { normalizeUuid } from '../util/normalizeUuid';
import * as log from '../logging/log';

// When true - we are running the very first storage and contact sync after
// linking.
let isInitialSync = false;

export function setIsInitialSync(newValue: boolean): void {
  log.info(`setIsInitialSync(${newValue})`);
  isInitialSync = newValue;
}

async function updateConversationFromContactSync(
  conversation: ConversationModel,
  details: ModifiedContactDetails,
  receivedAtCounter: number
): Promise<void> {
  const { writeNewAttachmentData, deleteAttachmentData, doesAttachmentExist } =
    window.Signal.Migrations;

  conversation.set({
    name: details.name,
    inbox_position: details.inboxPosition,
  });

  // Update the conversation avatar only if new avatar exists and hash differs
  const { avatar } = details;
  if (avatar && avatar.data) {
    const newAttributes = await Conversation.maybeUpdateAvatar(
      conversation.attributes,
      avatar.data,
      {
        writeNewAttachmentData,
        deleteAttachmentData,
        doesAttachmentExist,
      }
    );
    conversation.set(newAttributes);
  } else {
    const { attributes } = conversation;
    if (attributes.avatar && attributes.avatar.path) {
      await deleteAttachmentData(attributes.avatar.path);
    }
    conversation.set({ avatar: null });
  }

  // expireTimer isn't in Storage Service so we have to rely on contact sync.
  const { expireTimer } = details;
  const isValidExpireTimer = typeof expireTimer === 'number';
  if (isValidExpireTimer) {
    await conversation.updateExpirationTimer(expireTimer, {
      source: window.ConversationController.getOurConversationId(),
      receivedAt: receivedAtCounter,
      fromSync: true,
      isInitialSync,
      reason: 'contact sync',
    });
  }

  window.Whisper.events.trigger('incrementProgress');
}

const queue = new PQueue({ concurrency: 1 });

async function doContactSync({
  contacts,
  complete,
  receivedAtCounter,
}: ContactSyncEvent): Promise<void> {
  // iOS sets `syncMessage.contacts.complete` flag to `true` unconditionally
  // and so we have to employ tricks to figure out whether the sync is full or
  // partial. Thankfully, iOS sends only two kinds of contact syncs: full or
  // local sync. Local sync is always a single our own contact so we can do an
  // UUID check.
  const isFullSync =
    complete &&
    !(
      contacts.length === 1 &&
      normalizeUuid(contacts[0].uuid, 'doContactSync') ===
        window.storage.user.getUuid()?.toString()
    );

  const logId = `doContactSync(${receivedAtCounter}, isFullSync=${isFullSync})`;
  log.info(`${logId}: got ${contacts.length} contacts`);

  const updatedConversations = new Set<ConversationModel>();

  let promises = new Array<Promise<void>>();
  for (const details of contacts) {
    const partialConversation: ValidateConversationType = {
      e164: details.number,
      uuid: UUID.cast(details.uuid),
      type: 'private',
    };

    const validationError = validateConversation(partialConversation);
    if (validationError) {
      log.error(
        `${logId}: Invalid contact received`,
        Errors.toLogFormat(validationError)
      );
      continue;
    }

    const conversation = window.ConversationController.maybeMergeContacts({
      e164: details.number,
      aci: details.uuid,
      reason: logId,
    });
    strictAssert(conversation, 'need conversation to queue the job!');

    // It's important to use queueJob here because we might update the expiration timer
    //   and we don't want conflicts with incoming message processing happening on the
    //   conversation queue.
    const job = conversation.queueJob(`${logId}.set`, async () => {
      try {
        await updateConversationFromContactSync(
          conversation,
          details,
          receivedAtCounter
        );

        updatedConversations.add(conversation);
      } catch (error) {
        log.error(
          'updateConversationFromContactSync error:',
          Errors.toLogFormat(error)
        );
      }
    });

    promises.push(job);
  }

  // updatedConversations are not populated until the promises are resolved
  await Promise.all(promises);
  promises = [];

  // Erase data in conversations that are not the part of contact sync only
  // if we received a full contact sync (and not a one-off contact update).
  const notUpdated = isFullSync
    ? window.ConversationController.getAll().filter(
        convo =>
          !updatedConversations.has(convo) &&
          isDirectConversation(convo.attributes) &&
          !isMe(convo.attributes)
      )
    : [];

  log.info(
    `${logId}: ` +
      `updated ${updatedConversations.size} ` +
      `resetting ${notUpdated.length}`
  );

  for (const conversation of notUpdated) {
    conversation.set({
      name: undefined,
      inbox_position: undefined,
    });
  }

  // Save new conversation attributes
  promises.push(
    window.Signal.Data.updateConversations(
      [...updatedConversations, ...notUpdated].map(convo => convo.attributes)
    )
  );

  await Promise.all(promises);

  await window.storage.put('synced_at', Date.now());
  window.Whisper.events.trigger('contactSync:complete');
}

export async function onContactSync(ev: ContactSyncEvent): Promise<void> {
  log.info(`onContactSync(${ev.receivedAtCounter}): queueing sync`);
  await queue.add(() => doContactSync(ev));
}
