// file: src/Utils/message.ts
// Full replacement file (TypeScript, ESM)
//
// هدف الملف: دعم interactive nativeFlow + MD patch تلقائي للأزرار
// ملاحظة: لو مسارات الـ imports عندك مختلفة، عدلها لتطابق مشروعك.

import { Boom } from '@hapi/boom'
import axios from 'axios'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import type { Transform } from 'stream'
import { proto } from '../../WAProto/index.js'
import {
	MEDIA_KEYS,
	URL_REGEX,
	WA_DEFAULT_EPHEMERAL,
	type MediaType
} from '../Defaults/index.js'
import type {
	AnyMediaMessageContent,
	AnyMessageContent,
	DownloadableMessage,
	MessageContentGenerationOptions,
	MessageGenerationOptions,
	MessageGenerationOptionsFromContent,
	MessageUserReceipt,
	MessageWithContextInfo,
	WAMediaUpload,
	WAMessage,
	WAMessageContent,
	WAMessageKey,
	WATextMessage
} from '../Types/index.js'
import { WAMessageStatus, WAProto } from '../Types/index.js'
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js'
import { sha256 } from './crypto.js'
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js'
import type { ILogger } from './logger.js'
import {
	downloadContentFromMessage,
	encryptedStream,
	generateThumbnail,
	getAudioDuration,
	getAudioWaveform,
	getRawMediaUploadData,
	type MediaDownloadOptions
} from './messages-media.js'
import { shouldIncludeReportingToken } from './reporting-utils.js'

type ExtractByKey<T, K extends PropertyKey> = T extends Record<K, any> ? T : never
type RequireKey<T, K extends keyof T> = T & { [P in K]-?: Exclude<T[P], null | undefined> }
type WithKey<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? RequireKey<T, K> : never) : never

type MediaUploadData = {
	media: WAMediaUpload
	caption?: string
	ptt?: boolean
	ptv?: boolean
	seconds?: number
	gifPlayback?: boolean
	fileName?: string
	jpegThumbnail?: string
	mimetype?: string
	width?: number
	height?: number
	waveform?: Uint8Array
	backgroundArgb?: number
}

type NativeFlowButton = {
	name: string
	buttonParamsJson: string
	messageParamsJson?: string
}

type NativeFlowPayload = {
	title?: string
	subtitle?: string
	body: string
	footer?: string
	mentions?: string[]
	contextInfo?: proto.IContextInfo
	media?: AnyMediaMessageContent // { image: ... } | { video: ... } | { document: ... }
	buttons: NativeFlowButton[]
}

const MIMETYPE_MAP: { [T in MediaType]?: string } = {
	image: 'image/jpeg',
	video: 'video/mp4',
	document: 'application/pdf',
	audio: 'audio/ogg; codecs=opus',
	sticker: 'image/webp',
	'product-catalog-image': 'image/jpeg'
}

const MessageTypeProto = {
	image: WAProto.Message.ImageMessage,
	video: WAProto.Message.VideoMessage,
	audio: WAProto.Message.AudioMessage,
	sticker: WAProto.Message.StickerMessage,
	document: WAProto.Message.DocumentMessage
} as const

/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 */
export const extractUrlFromText = (text: string) => text.match(URL_REGEX)?.[0]

export const generateLinkPreviewIfRequired = async (
	text: string,
	getUrlInfo: MessageGenerationOptions['getUrlInfo'],
	logger: MessageGenerationOptions['logger']
) => {
	const url = extractUrlFromText(text)
	if (!!getUrlInfo && url) {
		try {
			return await getUrlInfo(url)
		} catch (error: any) {
			logger?.warn({ trace: error.stack }, 'url generation failed')
		}
	}
}

const assertColor = async (color: any) => {
	if (typeof color === 'number') return color > 0 ? color : 0xffffffff + Number(color) + 1
	let hex = String(color).trim().replace('#', '')
	if (hex.length <= 6) hex = 'FF' + hex.padStart(6, '0')
	return parseInt(hex, 16)
}

export const hasNonNullishProperty = <K extends PropertyKey>(
	message: AnyMessageContent,
	key: K
): message is ExtractByKey<AnyMessageContent, K> => {
	return (
		typeof message === 'object' &&
		message !== null &&
		key in message &&
		(message as any)[key] !== null &&
		(message as any)[key] !== undefined
	)
}

function hasOptionalProperty<T, K extends PropertyKey>(obj: T, key: K): obj is WithKey<T, K> {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		key in obj &&
		(obj as any)[key] !== null &&
		(obj as any)[key] !== undefined
	)
}

/**
 * MD Patch للأزرار/القوائم/interactive:
 * يلفّ الرسالة داخل viewOnceMessageV2Extension + deviceListMetadataVersion=2
 */
export const patchMessageForMdIfRequired = (message: proto.IMessage) => {
	const needsPatch =
		(message as any)?.buttonsMessage ||
		(message as any)?.templateMessage ||
		(message as any)?.listMessage ||
		(message as any)?.interactiveMessage

	if (!needsPatch) return message
	if ((message as any)?.viewOnceMessageV2Extension) return message

	return WAProto.Message.fromObject({
		viewOnceMessageV2Extension: {
			message: {
				messageContextInfo: {
					deviceListMetadataVersion: 2,
					deviceListMetadata: {}
				},
				...message
			}
		}
	})
}

export const prepareWAMessageMedia = async (
	message: AnyMediaMessageContent,
	options: MessageContentGenerationOptions
) => {
	const logger = options.logger

	let mediaType: (typeof MEDIA_KEYS)[number] | undefined
	for (const key of MEDIA_KEYS) {
		if (key in message) mediaType = key
	}

	if (!mediaType) throw new Boom('Invalid media type', { statusCode: 400 })

	const uploadData: MediaUploadData = {
		...message,
		media: (message as any)[mediaType]
	}
	delete (uploadData as any)[mediaType]

	const cacheableKey =
		typeof uploadData.media === 'object' &&
		uploadData.media &&
		'url' in uploadData.media &&
		!!(uploadData.media as any).url &&
		!!options.mediaCache &&
		`${mediaType}:${(uploadData.media as any).url.toString()}`

	if (mediaType === 'document' && !uploadData.fileName) uploadData.fileName = 'file'
	if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]

	if (cacheableKey) {
		const mediaBuff = await options.mediaCache!.get<Buffer>(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')
			const obj = proto.Message.decode(mediaBuff)
			const key = `${mediaType}Message`
			Object.assign(obj[key as keyof proto.Message]!, { ...uploadData, media: undefined })
			return obj
		}
	}

	const isNewsletter = !!options.jid && isJidNewsletter(options.jid)
	if (isNewsletter) {
		logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')

		const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(
			uploadData.media,
			options.mediaTypeOverride || mediaType,
			logger
		)

		const fileSha256B64 = fileSha256.toString('base64')
		const { mediaUrl, directPath } = await options.upload(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType,
			timeoutMs: options.mediaUploadTimeoutMs
		})

		await fs.unlink(filePath)

		const obj = WAProto.Message.fromObject({
			[`${mediaType}Message`]: (MessageTypeProto as any)[mediaType].fromObject({
				url: mediaUrl,
				directPath,
				fileSha256,
				fileLength,
				...uploadData,
				media: undefined
			})
		})

		if (uploadData.ptv) {
			obj.ptvMessage = obj.videoMessage
			delete obj.videoMessage
		}

		if (obj.stickerMessage) obj.stickerMessage.stickerSentTs = Date.now()

		if (cacheableKey) {
			logger?.debug({ cacheableKey }, 'set cache')
			await options.mediaCache!.set(cacheableKey, WAProto.Message.encode(obj).finish())
		}

		return obj
	}

	const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
	const requiresThumbnailComputation =
		(mediaType === 'image' || mediaType === 'video') && typeof uploadData.jpegThumbnail === 'undefined'
	const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true
	const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
	const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation

	const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(
		uploadData.media,
		options.mediaTypeOverride || mediaType,
		{ logger, saveOriginalFileIfRequired: requiresOriginalForSomeProcessing, opts: options.options }
	)

	const fileEncSha256B64 = fileEncSha256.toString('base64')

	const [{ mediaUrl, directPath }] = await Promise.all([
		(async () => {
			const result = await options.upload(encFilePath, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs })
			logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
			return result
		})(),
		(async () => {
			try {
				if (requiresThumbnailComputation) {
					const { thumbnail, originalImageDimensions } = await generateThumbnail(
						originalFilePath!,
						mediaType as 'image' | 'video',
						options
					)
					uploadData.jpegThumbnail = thumbnail
					if (!uploadData.width && originalImageDimensions) {
						uploadData.width = originalImageDimensions.width
						uploadData.height = originalImageDimensions.height
					}
				}

				if (requiresDurationComputation) uploadData.seconds = await getAudioDuration(originalFilePath!)
				if (requiresWaveformProcessing) uploadData.waveform = await getAudioWaveform(originalFilePath!, logger)
				if (requiresAudioBackground) uploadData.backgroundArgb = await assertColor(options.backgroundColor)
			} catch (error: any) {
				logger?.warn({ trace: error.stack }, 'failed to obtain extra info')
			}
		})()
	]).finally(async () => {
		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) await fs.unlink(originalFilePath)
		} catch {
			logger?.warn('failed to remove tmp file')
		}
	})

	const obj = WAProto.Message.fromObject({
		[`${mediaType}Message`]: MessageTypeProto[mediaType as keyof typeof MessageTypeProto].fromObject({
			url: mediaUrl,
			directPath,
			mediaKey,
			fileEncSha256,
			fileSha256,
			fileLength,
			mediaKeyTimestamp: unixTimestampSeconds(),
			...uploadData,
			media: undefined
		} as any)
	})

	if (uploadData.ptv) {
		obj.ptvMessage = obj.videoMessage
		delete obj.videoMessage
	}

	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache')
		await options.mediaCache!.set(cacheableKey, WAProto.Message.encode(obj).finish())
	}

	return obj
}

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration?: number) => {
	const content: WAMessageContent = {
		ephemeralMessage: {
			message: {
				protocolMessage: {
					type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration: ephemeralExpiration || 0
				}
			}
		}
	}
	return WAProto.Message.fromObject(content)
}

export const generateForwardMessageContent = (message: WAMessage, forceForward?: boolean) => {
	let content = message.message
	if (!content) throw new Boom('no content in message', { statusCode: 400 })

	content = normalizeMessageContent(content)
	content = proto.Message.decode(proto.Message.encode(content!).finish())

	let key = Object.keys(content)[0] as keyof proto.IMessage
	let score = (content?.[key] as any)?.contextInfo?.forwardingScore || 0
	score += message.key.fromMe && !forceForward ? 0 : 1

	if (key === 'conversation') {
		content.extendedTextMessage = { text: content[key] as any }
		delete (content as any).conversation
		key = 'extendedTextMessage'
	}

	if (score > 0) (content[key] as any).contextInfo = { forwardingScore: score, isForwarded: true }
	else (content[key] as any).contextInfo = {}

	return content
}

const buildNativeFlowInteractiveMessage = async (
	payload: NativeFlowPayload,
	options: MessageContentGenerationOptions
): Promise<WAMessageContent> => {
	let headerMedia: any = undefined

	if (payload.media) {
		const prepared = await prepareWAMessageMedia(payload.media, options)
		headerMedia = prepared
	}

	const mentionedJid = payload.mentions?.length ? payload.mentions : payload.contextInfo?.mentionedJid || []

	const interactive: any = {
		header: {
			title: payload.title || '',
			subtitle: payload.subtitle || '',
			hasMediaAttachment: Boolean(headerMedia),
			...(headerMedia?.imageMessage ? { imageMessage: headerMedia.imageMessage } : {}),
			...(headerMedia?.videoMessage ? { videoMessage: headerMedia.videoMessage } : {}),
			...(headerMedia?.documentMessage ? { documentMessage: headerMedia.documentMessage } : {})
		},
		body: { text: payload.body || '' },
		...(payload.footer ? { footer: { text: payload.footer } } : {}),
		contextInfo: {
			...(payload.contextInfo || {}),
			...(mentionedJid.length ? { mentionedJid } : {}),
			isForwarded: false
		},
		nativeFlowMessage: {
			buttons: (payload.buttons || []).map(b => ({
				name: b.name,
				buttonParamsJson: b.buttonParamsJson,
				messageParamsJson: b.messageParamsJson || ''
			}))
		}
	}

	return { interactiveMessage: interactive }
}

export const generateWAMessageContent = async (
	message: AnyMessageContent,
	options: MessageContentGenerationOptions & { patchInteractiveMd?: boolean }
) => {
	let m: WAMessageContent = {}

	if (hasNonNullishProperty(message, 'text')) {
		const extContent = { text: message.text } as WATextMessage

		let urlInfo = (message as any).linkPreview
		if (typeof urlInfo === 'undefined') urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)

		if (urlInfo) {
			extContent.matchedText = urlInfo['matched-text']
			extContent.jpegThumbnail = urlInfo.jpegThumbnail
			extContent.description = urlInfo.description
			extContent.title = urlInfo.title
			extContent.previewType = 0

			const img = urlInfo.highQualityThumbnail
			if (img) {
				extContent.thumbnailDirectPath = img.directPath
				extContent.mediaKey = img.mediaKey
				extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
				extContent.thumbnailWidth = img.width
				extContent.thumbnailHeight = img.height
				extContent.thumbnailSha256 = img.fileSha256
				extContent.thumbnailEncSha256 = img.fileEncSha256
			}
		}

		if (options.backgroundColor) extContent.backgroundArgb = await assertColor(options.backgroundColor)
		if ((options as any).textColor) (extContent as any).textArgb = await assertColor((options as any).textColor)
		if (options.font) extContent.font = options.font

		m.extendedTextMessage = extContent
	} else if (hasNonNullishProperty(message, 'contacts')) {
		const contactLen = message.contacts.contacts.length
		if (!contactLen) throw new Boom('require atleast 1 contact', { statusCode: 400 })
		if (contactLen === 1) m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0])
		else m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts)
	} else if (hasNonNullishProperty(message, 'location')) {
		if ((message as any).live) m.liveLocationMessage = WAProto.Message.LiveLocationMessage.create(message.location as any)
		else m.locationMessage = WAProto.Message.LocationMessage.create(message.location)
	} else if (hasNonNullishProperty(message, 'react')) {
		if (!(message as any).react.senderTimestampMs) (message as any).react.senderTimestampMs = Date.now()
		m.reactionMessage = WAProto.Message.ReactionMessage.create((message as any).react)
	} else if (hasNonNullishProperty(message, 'delete')) {
		m.protocolMessage = { key: (message as any).delete, type: WAProto.Message.ProtocolMessage.Type.REVOKE }
	} else if (hasNonNullishProperty(message, 'forward')) {
		m = generateForwardMessageContent((message as any).forward, (message as any).force)
	} else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
		const exp =
			typeof (message as any).disappearingMessagesInChat === 'boolean'
				? (message as any).disappearingMessagesInChat
					? WA_DEFAULT_EPHEMERAL
					: 0
				: (message as any).disappearingMessagesInChat
		m = prepareDisappearingMessageSettingContent(exp)
	} else if (hasNonNullishProperty(message, 'buttonReply')) {
		switch ((message as any).type) {
			case 'list':
				;(m as any).listResponseMessage = {
					title: (message as any).buttonReply.title,
					description: (message as any).buttonReply.description,
					singleSelectReply: { selectedRowId: (message as any).buttonReply.rowId },
					listType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
				}
				break
			case 'template':
				m.templateButtonReplyMessage = {
					selectedDisplayText: (message as any).buttonReply.displayText,
					selectedId: (message as any).buttonReply.id,
					selectedIndex: (message as any).buttonReply.index
				}
				break
			case 'plain':
				m.buttonsResponseMessage = {
					selectedButtonId: (message as any).buttonReply.id,
					selectedDisplayText: (message as any).buttonReply.displayText,
					type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
				}
				break
			case 'interactive':
				;(m as any).interactiveResponseMessage = {
					body: {
						text: (message as any).buttonReply.displayText,
						format: proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
					},
					nativeFlowResponseMessage: {
						name: (message as any).buttonReply.nativeFlows?.name,
						paramsJson: (message as any).buttonReply.nativeFlows?.paramsJson,
						version: (message as any).buttonReply.nativeFlows?.version
					}
				}
				break
		}
	}
	// ✅ مهم: nativeFlow builder
	else if (hasNonNullishProperty(message, 'nativeFlow')) {
		m = await buildNativeFlowInteractiveMessage((message as any).nativeFlow as NativeFlowPayload, options)
	} else {
		m = await prepareWAMessageMedia(message as any, options)
	}

	// mentions merge
	if (hasOptionalProperty(message, 'mentions') && (message as any).mentions?.length) {
		const messageType = Object.keys(m)[0] as any
		const key = (m as any)[messageType]
		if (key) {
			key.contextInfo = key.contextInfo || {}
			key.contextInfo.mentionedJid = (message as any).mentions
		}
	}

	// contextInfo merge
	if (hasOptionalProperty(message, 'contextInfo') && (message as any).contextInfo) {
		const messageType = Object.keys(m)[0] as any
		const key = (m as any)[messageType]
		if (key) {
			key.contextInfo = key.contextInfo ? { ...key.contextInfo, ...(message as any).contextInfo } : (message as any).contextInfo
		}
	}

	// wrappers
	if (hasOptionalProperty(message, 'ephemeral') && (message as any).ephemeral) m = { ephemeralMessage: { message: m } } as any
	if (hasOptionalProperty(message, 'viewOnce') && (message as any).viewOnce) m = { viewOnceMessage: { message: m } } as any
	if (hasOptionalProperty(message, 'viewOnceV2') && (message as any).viewOnceV2) m = { viewOnceMessageV2: { message: m } } as any

	// edit
	if (hasOptionalProperty(message, 'edit')) {
		m = {
			protocolMessage: {
				key: (message as any).edit,
				editedMessage: m,
				timestampMs: Date.now(),
				type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
			}
		} as any
	}

	// reporting token
	if (shouldIncludeReportingToken(m)) {
		;(m as any).messageContextInfo = (m as any).messageContextInfo || {}
		if (!(m as any).messageContextInfo.messageSecret) (m as any).messageContextInfo.messageSecret = randomBytes(32)
	}

	// ✅ build + MD patch (افتراضي)
	const built = WAProto.Message.create(m as any)
	const patchEnabled = options.patchInteractiveMd !== false
	return patchEnabled ? patchMessageForMdIfRequired(built as any) : (built as any)
}

export const generateWAMessageFromContent = (
	jid: string,
	message: WAMessageContent,
	options: MessageGenerationOptionsFromContent
) => {
	if (!options.timestamp) options.timestamp = new Date()

	const innerMessage = normalizeMessageContent(message)!
	const key = getContentType(innerMessage)! as Exclude<keyof proto.IMessage, 'conversation'>
	const timestamp = unixTimestampSeconds(options.timestamp)
	const { quoted, userJid } = options

	if (quoted && !isJidNewsletter(jid)) {
		const participant = quoted.key.fromMe ? userJid : quoted.participant || quoted.key.participant || quoted.key.remoteJid

		let quotedMsg = normalizeMessageContent(quoted.message)!
		const msgType = getContentType(quotedMsg)!
		quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] })

		const quotedContent = quotedMsg[msgType]
		if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) delete (quotedContent as any).contextInfo

		const contextInfo: proto.IContextInfo =
			('contextInfo' in (innerMessage as any)[key]! && (innerMessage as any)[key]?.contextInfo) || {}

		contextInfo.participant = jidNormalizedUser(participant!)
		contextInfo.stanzaId = quoted.key.id
		contextInfo.quotedMessage = quotedMsg

		if (jid !== quoted.key.remoteJid) contextInfo.remoteJid = quoted.key.remoteJid
		;(innerMessage as any)[key].contextInfo = contextInfo
	}

	if (
		!!options?.ephemeralExpiration &&
		key !== 'protocolMessage' &&
		key !== 'ephemeralMessage' &&
		!isJidNewsletter(jid)
	) {
		;(innerMessage as any)[key].contextInfo = {
			...((innerMessage as any)[key].contextInfo || {}),
			expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
		}
	}

	const msg = WAProto.Message.create(message as any)

	const messageJSON = {
		key: {
			remoteJid: jid,
			fromMe: true,
			id: options?.messageId || generateMessageIDV2()
		},
		message: msg,
		messageTimestamp: timestamp,
		messageStubParameters: [],
		participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
		status: WAMessageStatus.PENDING
	}

	return WAProto.WebMessageInfo.fromObject(messageJSON) as WAMessage
}

export const generateWAMessage = async (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => {
	options.logger = options?.logger?.child({ msgId: options.messageId })
	return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid } as any), options)
}

export const getContentType = (content: proto.IMessage | undefined) => {
	if (!content) return undefined
	const keys = Object.keys(content)
	const key = keys.find(
		k =>
			(k === 'conversation' || k.endsWith('Message') || k.endsWith('V2') || k.endsWith('V3') || k.endsWith('V4') || k.endsWith('V5')) &&
			k !== 'senderKeyDistributionMessage' &&
			k !== 'messageContextInfo'
	)
	return key as keyof typeof content
}

export const normalizeMessageContent = (content: WAMessageContent | null | undefined): WAMessageContent | undefined => {
	if (!content) return undefined

	for (let i = 0; i < 5; i++) {
		const inner =
			(content as any)?.editedMessage ||
			(content as any)?.viewOnceMessage ||
			(content as any)?.viewOnceMessageV2 ||
			(content as any)?.viewOnceMessageV2Extension ||
			(content as any)?.ephemeralMessage ||
			(content as any)?.documentWithCaptionMessage ||
			(content as any)?.associatedChildMessage ||
			(content as any)?.groupStatusMessage ||
			(content as any)?.groupStatusMessageV2

		if (!inner) break
		content = inner.message
	}

	return content as any
}

export const extractMessageContent = (content: WAMessageContent | undefined | null): WAMessageContent | undefined => {
	const extractFromButtonsLike = (msg: any) => {
		const header = typeof msg.header === 'object' && msg.header !== null
		const h = header ? msg.header : msg

		if (h?.imageMessage) return { imageMessage: h.imageMessage }
		if (h?.documentMessage) return { documentMessage: h.documentMessage }
		if (h?.videoMessage) return { videoMessage: h.videoMessage }
		if (h?.locationMessage) return { locationMessage: h.locationMessage }
		if (h?.productMessage) return { productMessage: h.productMessage }

		return {
			conversation:
				'contentText' in msg
					? msg.contentText
					: 'hydratedContentText' in msg
						? msg.hydratedContentText
						: msg?.body?.text || ''
		}
	}

	content = normalizeMessageContent(content)
	if (!content) return undefined

	if ((content as any).buttonsMessage) return extractFromButtonsLike((content as any).buttonsMessage)
	if ((content as any).interactiveMessage) return extractFromButtonsLike((content as any).interactiveMessage)
	if ((content as any).templateMessage?.interactiveMessageTemplate)
		return extractFromButtonsLike((content as any).templateMessage.interactiveMessageTemplate)
	if ((content as any).templateMessage?.hydratedFourRowTemplate)
		return extractFromButtonsLike((content as any).templateMessage.hydratedFourRowTemplate)
	if ((content as any).templateMessage?.hydratedTemplate)
		return extractFromButtonsLike((content as any).templateMessage.hydratedTemplate)
	if ((content as any).templateMessage?.fourRowTemplate)
		return extractFromButtonsLike((content as any).templateMessage.fourRowTemplate)

	return content
}

export const getDevice = (id: string) =>
	/^3A.{18}$/.test(id)
		? 'ios'
		: /^3E.{20}$/.test(id)
			? 'web'
			: /^(.{21}|.{32})$/.test(id)
				? 'android'
				: /^(3F|.{18}$)/.test(id)
					? 'desktop'
					: 'baileys'

export const updateMessageWithReceipt = (msg: Pick<WAMessage, 'userReceipt'>, receipt: MessageUserReceipt) => {
	msg.userReceipt = msg.userReceipt || []
	const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
	if (recp) Object.assign(recp, receipt)
	else msg.userReceipt.push(receipt)
}

export const updateMessageWithReaction = (msg: Pick<WAMessage, 'reactions'>, reaction: proto.IReaction) => {
	const authorID = getKeyAuthor(reaction.key)
	const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID)
	reaction.text = reaction.text || ''
	reactions.push(reaction)
	msg.reactions = reactions
}

export const updateMessageWithPollUpdate = (msg: Pick<WAMessage, 'pollUpdates'>, update: proto.IPollUpdate) => {
	const authorID = getKeyAuthor(update.pollUpdateMessageKey)
	const votes = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID)
	if (update.vote?.selectedOptions?.length) votes.push(update)
	msg.pollUpdates = votes
}

export const updateMessageWithEventResponse = (
	msg: Pick<WAMessage, 'eventResponses'>,
	update: proto.IEventResponse
) => {
	const authorID = getKeyAuthor(update.eventResponseMessageKey)
	const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID)
	responses.push(update)
	msg.eventResponses = responses
}

type VoteAggregation = { name: string; voters: string[] }

export function getAggregateVotesInPollMessage(
	{ message, pollUpdates }: Pick<WAMessage, 'pollUpdates' | 'message'>,
	meId?: string
) {
	const opts =
		(message as any)?.pollCreationMessage?.options ||
		(message as any)?.pollCreationMessageV2?.options ||
		(message as any)?.pollCreationMessageV3?.options ||
		[]

	const voteHashMap = opts.reduce((acc: Record<string, VoteAggregation>, opt: any) => {
		const hash = sha256(Buffer.from(opt.optionName || '')).toString()
		acc[hash] = { name: opt.optionName || '', voters: [] }
		return acc
	}, {})

	for (const update of pollUpdates || []) {
		const vote = (update as any).vote
		if (!vote) continue

		for (const option of vote.selectedOptions || []) {
			const hash = option.toString()
			if (!voteHashMap[hash]) voteHashMap[hash] = { name: 'Unknown', voters: [] }
			voteHashMap[hash].voters.push(getKeyAuthor((update as any).pollUpdateMessageKey, meId))
		}
	}

	return Object.values(voteHashMap)
}

export const aggregateMessageKeysNotFromMe = (keys: WAMessageKey[]) => {
	const keyMap: Record<string, { jid: string; participant: string | undefined; messageIds: string[] }> = {}
	for (const { remoteJid, id, participant, fromMe } of keys) {
		if (!fromMe) {
			const uqKey = `${remoteJid}:${participant || ''}`
			if (!keyMap[uqKey]) keyMap[uqKey] = { jid: remoteJid!, participant: participant!, messageIds: [] }
			keyMap[uqKey].messageIds.push(id!)
		}
	}
	return Object.values(keyMap)
}

type DownloadMediaMessageContext = {
	reuploadRequest: (msg: WAMessage) => Promise<WAMessage>
	logger: ILogger
}

const REUPLOAD_REQUIRED_STATUS = [410, 404]

export const downloadMediaMessage = async <Type extends 'buffer' | 'stream'>(
	message: WAMessage,
	type: Type,
	options: MediaDownloadOptions,
	ctx?: DownloadMediaMessageContext
) => {
	const result = await downloadMsg().catch(async (error: any) => {
		const status = axios.isAxiosError(error) ? error.response?.status : error?.status
		if (ctx && typeof status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(status)) {
			ctx.logger.info({ key: message.key }, 'sending reupload media request...')
			message = await ctx.reuploadRequest(message)
			return await downloadMsg()
		}
		throw error
	})

	return result as Type extends 'buffer' ? Buffer : Transform

	async function downloadMsg() {
		const mContent = extractMessageContent(message.message)
		if (!mContent) throw new Boom('No message present', { statusCode: 400, data: message })

		const contentType = getContentType(mContent)
		let mediaType = contentType?.replace('Message', '') as MediaType
		const media = (mContent as any)[contentType!]

		if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
			throw new Boom(`"${contentType}" message is not a media message`)
		}

		let download: DownloadableMessage
		if ('thumbnailDirectPath' in media && !('url' in media)) {
			download = { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey }
			mediaType = 'thumbnail-link'
		} else {
			download = media
		}

		const stream = await downloadContentFromMessage(download, mediaType, options)

		if (type === 'buffer') {
			const chunks: Buffer[] = []
			for await (const chunk of stream) chunks.push(chunk as Buffer)
			return Buffer.concat(chunks)
		}

		return stream as any
	}
}

export const assertMediaContent = (content: proto.IMessage | null | undefined) => {
	content = extractMessageContent(content)
	const mediaContent =
		(content as any)?.documentMessage ||
		(content as any)?.imageMessage ||
		(content as any)?.videoMessage ||
		(content as any)?.audioMessage ||
		(content as any)?.stickerMessage

	if (!mediaContent) throw new Boom('given message is not a media message', { statusCode: 400, data: content })
	return mediaContent
}
