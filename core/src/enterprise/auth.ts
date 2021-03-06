/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import qs = require("qs")
import open from "open"
import { Server } from "http"
import Koa from "koa"
import { EventEmitter2 } from "eventemitter2"
import bodyParser = require("koa-bodyparser")
import Router = require("koa-router")
import getPort = require("get-port")
import { ClientAuthToken } from "../db/entities/client-auth-token"
import { LogEntry } from "../logger/log-entry"
import { got } from "../util/http"
import { RuntimeError, InternalError } from "../exceptions"
import { gardenEnv } from "../constants"

// If a GARDEN_AUTH_TOKEN is present and Garden is NOT running from a workflow runner pod,
// switch to ci-token authentication method.
export const authTokenHeader =
  gardenEnv.GARDEN_AUTH_TOKEN && !gardenEnv.GARDEN_GE_SCHEDULED ? "x-ci-token" : "x-access-auth-token"
export const makeAuthHeader = (clientAuthToken: string) => ({ [authTokenHeader]: clientAuthToken })

// TODO: Add error handling and tests for all of this

/**
 * Logs in to Garden Enterprise if needed, and returns a valid client auth token.
 */
export async function login(enterpriseDomain: string, log: LogEntry): Promise<string> {
  const savedToken = await readAuthToken(log)
  // Ping platform with saved token (if it exists)
  if (savedToken) {
    log.debug("Local client auth token found, verifying it with platform...")
    if (await checkClientAuthToken(savedToken, enterpriseDomain, log)) {
      log.debug("Local client token is valid, no need for login.")
      return savedToken
    }
  }

  /**
   * Else, start auth redirect server and wait for its redirect handler to receive
   * the redirect and finish running.
   */
  const events = new EventEmitter2()
  const server = new AuthRedirectServer(enterpriseDomain, events, log)
  log.debug(`Redirecting to Garden Enterprise login page...`)
  const newToken: string = await new Promise(async (resolve, _reject) => {
    // The server resolves the promise with the new auth token once it's received the redirect.
    await server.start()
    events.once("receivedToken", ({ token }: { token: string }) => {
      log.debug("Received client auth token.")
      resolve(token)
    })
  })
  await server.close()
  if (!newToken) {
    throw new InternalError(`Error: Did not receive an auth token after logging in.`, {})
  }
  await saveAuthToken(newToken, log)
  return newToken
}

/**
 * Checks with the backend whether the provided client auth token is valid.
 */
export async function checkClientAuthToken(token: string, enterpriseDomain: string, log: LogEntry): Promise<boolean> {
  let valid = false
  try {
    log.debug(`Checking client auth token with platform: ${enterpriseDomain}/token/verify`)
    await got({
      method: "get",
      url: `${enterpriseDomain}/token/verify`,
      headers: makeAuthHeader(token),
    })
    valid = true
  } catch (err) {
    const res = err.response
    if (res && res.statusCode === 401) {
      valid = false
    } else {
      throw new RuntimeError(`An error occurred while verifying client auth token with platform: ${err.message}`, {})
    }
  }
  log.debug(`Checked client auth token with platform - valid: ${valid}`)
  return valid
}

/**
 * We make a transaction deleting all existing client auth tokens and creating a new token.
 *
 * This also covers the inconsistent/erroneous case of more than one auth token existing in the local store.
 */
export async function saveAuthToken(token: string, log: LogEntry) {
  try {
    const manager = ClientAuthToken.getConnection().manager
    await manager.transaction(async (transactionalEntityManager) => {
      await transactionalEntityManager.clear(ClientAuthToken)
      await transactionalEntityManager.save(ClientAuthToken, ClientAuthToken.create({ token }))
    })
    log.debug("Saved client auth token to local config db")
  } catch (error) {
    log.error(`An error occurred while saving client auth token to local config db:\n${error.message}`)
  }
}

/**
 * If a persisted client auth token was found, or if the GARDEN_AUTH_TOKEN environment variable is present, returns it.
 * Returns null otherwise.
 *
 * Note that the GARDEN_AUTH_TOKEN environment variable takes precedence over a persisted auth token if both are
 * present.
 *
 * In the inconsistent/erroneous case of more than one auth token existing in the local store, picks the first auth
 * token and deletes all others.
 */
export async function readAuthToken(log: LogEntry): Promise<string | null> {
  const tokenFromEnv = gardenEnv.GARDEN_AUTH_TOKEN
  if (tokenFromEnv) {
    log.debug("Read client auth token from env")
    return tokenFromEnv
  }

  const [tokens, tokenCount] = await ClientAuthToken.findAndCount()

  const token = tokens[0] ? tokens[0].token : null

  if (tokenCount > 1) {
    log.debug("More than one client auth tokens found, clearing up...")
    try {
      await ClientAuthToken.getConnection()
        .createQueryBuilder()
        .delete()
        .from(ClientAuthToken)
        .where("token != :token", { token })
        .execute()
    } catch (error) {
      log.error(`An error occurred while clearing up duplicate client auth tokens:\n${error.message}`)
    }
  }
  log.debug("Retrieved client auth token from local config db")

  return token
}

/**
 * If a persisted client auth token exists, deletes it.
 */
export async function clearAuthToken(log: LogEntry) {
  await ClientAuthToken.getConnection().createQueryBuilder().delete().from(ClientAuthToken).execute()
  log.debug("Cleared persisted auth token (if any)")
}

// TODO: Add analytics tracking
export class AuthRedirectServer {
  private log: LogEntry
  private server: Server
  private app: Koa
  private enterpriseDomain: string
  private events: EventEmitter2

  constructor(enterpriseDomain: string, events: EventEmitter2, log: LogEntry, public port?: number) {
    this.enterpriseDomain = enterpriseDomain
    this.events = events
    this.log = log.placeholder()
  }

  async start() {
    if (this.app) {
      return
    }

    if (!this.port) {
      this.port = await getPort()
    }

    await this.createApp()

    const query = { cliport: `${this.port}` }
    await open(`${this.enterpriseDomain}/cli/login/?${qs.stringify(query)}`)
  }

  async close() {
    this.log.debug("Shutting down redirect server...")
    return this.server.close()
  }

  async createApp() {
    const app = new Koa()
    const http = new Router()
    http.get("/", async (ctx) => {
      const token = ctx.request.query.jwt
      this.log.debug("Received client auth token")
      this.events.emit("receivedToken", { token })
      ctx.redirect("http://www.garden.io")
    })
    app.use(bodyParser())
    app.use(http.allowedMethods())
    app.use(http.routes())
    app.on("error", (err) => {
      this.log.error(`Auth redirect request failed with status ${err.status}: ${err.message}`)
    })
    this.server = app.listen(this.port)
  }
}
