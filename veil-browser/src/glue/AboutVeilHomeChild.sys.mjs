/* about:veil-home, content side (patch 0002).
 *
 * RemotePageChild exposes RPMSendAsyncMessage / RPMAddMessageListener to the
 * page, limited to the messages RemotePageAccessManager allows for
 * about:veil-home. The start page's bridge.js uses exactly those.
 */
import { RemotePageChild } from "resource://gre/actors/RemotePageChild.sys.mjs";

export class AboutVeilHomeChild extends RemotePageChild {}
