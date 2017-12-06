import {Permission} from "../model/Permission";
import {TimeStampedPermissions} from "../model/TimeStampedPermissions";
import {APIError} from "../model/APIError";
import {registered_permissions} from "./PermissionEndpoint";
import {Router, Request, Response, NextFunction} from "express";
import {request} from "http";
import { ClaimsError, ValidationError, InvalidTicketError, ExpiredTicketError, NotAuthorizedByPolicyError, UMARedirect } from "../model/Exceptions";
import { inspect } from "util";
import * as jwt from "jsonwebtoken";
import { PolicyEngine, Claims, Policy } from "../policy/PolicyEngine";
import { policyTypeToEnginesMap, policies } from "./PolicyEndpoint";
import { PolicyDecision, AuthorizationDecision, Obligations } from "../policy/Decisions";
import { SimplePolicyDecisionCombinerEngine } from "../policy/SimplePolicyDecisionCombinerEngine";

const config = require("../config.json");

export const UMA_REDIRECT_OBLIGATION_ID = "UMA_REDIRECT";
export const DENY_SCOPES_OBLIGATION_ID = "DENY_SCOPES";
export let issued_rpts: { [rpt: string]: TimeStampedPermissions } = {};

export class AuthorizationEndpoint {
  router: Router;

  constructor() {
    this.router = Router();
    this.init();
  }

  public createANewOne(req: Request, res: Response, next: NextFunction): void {
    try {
        AuthorizationEndpoint.validateRPTRequestParams(req.body);
        const ticket: string = req.body.ticket;
        const claimsString: string = req.body.claim_tokens;
        const claims: Claims = AuthorizationEndpoint.validateClaimsToken(claimsString);

        const permissions: TimeStampedPermissions = registered_permissions [ticket];
        AuthorizationEndpoint.validatePermissions(permissions);

        const rpt: TimeStampedPermissions = TimeStampedPermissions.issue(config.uma.authorization.rpt.ttl,
          AuthorizationEndpoint.checkPolicies(claims, permissions.permissions));

        issued_rpts[rpt.id] = rpt;
        res.status(201).send({rpt: rpt.id});
        delete registered_permissions[ticket];
    } catch (e) {
      if (e instanceof ValidationError) {
        res.status(400).send(
            new APIError(e.message,
            "MissingParameter",
            400
         ));
      } else if (e instanceof ClaimsError) {
        res.status(403).send(
            new APIError(`Invalid or insufficient claims token: ${e.message}`,
            "need_info",
            403
          ));
      } else if (e instanceof NotAuthorizedByPolicyError) {
        res.status(403).send(
          new APIError("Denied per authorization policies.",
          "not_authorized",
          403
        ));
      } else if (e instanceof UMARedirect) {
        res.status(401)
        .set("WWW-Authenticate", `UMA realm=${e.umaServerParams.realm} as_uri=${e.umaServerParams.as_uri}`)
        .send(
          new APIError("Denied per authorization policies.",
          "not_authorized",
          403
        ));
      } else if (e instanceof InvalidTicketError) {
        res.status(400).send(
          new APIError("Ticket is invalid.",
          "invalid_ticket",
          400
        ));
      } else if (e instanceof ExpiredTicketError) {
        res.status(400).send(
          new APIError("Ticket has expired.",
          "expired_ticket",
          400
        ));
      } else {
        res.status(500).send(
          new APIError("Internal server error.",
          "internal_error",
          500
        ));
        console.log(e);
      }
    }
  }

  private static checkPolicies(claims: Claims, permissions: Permission[]): Permission[] {
    const policyArray: Policy[] = Object.keys(policies).map((id) => policies[id]);
    const decision = new SimplePolicyDecisionCombinerEngine().evaluate(claims, policyArray, policyTypeToEnginesMap);
    if (decision.authorization === AuthorizationDecision.Deny) {
      throw new NotAuthorizedByPolicyError();
    } else if (decision.authorization === AuthorizationDecision.NotApplicable) {
      // failing safe on Deny if no applicable policies were found. This could be a configuration setting.
      throw new NotAuthorizedByPolicyError();
    } else if (decision.authorization === AuthorizationDecision.Indeterminate) {
      const e = new UMARedirect();
      e.umaServerParams = decision.obligations[UMA_REDIRECT_OBLIGATION_ID];
      throw e;
    }
    // else if (decision.authorization === AuthorizationDecision.Permit):
    return AuthorizationEndpoint.reconcilePermissionsAndObligations(permissions, decision.obligations);
  }

  private static reconcilePermissionsAndObligations (permissions: Permission[], obligations: Obligations): Permission[] {
    const deniedScopes = obligations[DENY_SCOPES_OBLIGATION_ID];
    if (deniedScopes) {
      return permissions.map((permission) => (
        {
          resource_id: permission.resource_id,
          resource_scopes: (permission.resource_scopes || []).filter((scope) => (
            ! deniedScopes.includes(scope)
          ))
        }
      )).filter((permission) => (
        ((permission.resource_scopes.length || 0) !== 0)
      ));
    } else {
      return permissions;
    }
  }

  private static validateRPTRequestParams(object: any): void {
    if (!object) {
      throw new ValidationError ("Bad Request.");
    } else if (! object.ticket) {
      throw new ValidationError ("Bad Request. Expecting a ticket.");
    }
  }

  private static validateClaimsToken(claimsString: string): Claims {
    if (!claimsString) {
      throw new ClaimsError("No claims token submitted.");
    }
    const claimChunks: string[] = claimsString.split(".", 3);
    if (claimChunks.length !== 3) {
      throw new ClaimsError("Submitted claims token not in JWT format.");
    }
    let payload: Claims = {};
    try {
      payload = JSON.parse(new Buffer(claimChunks[1], "base64").toString());
    } catch (e) {
      throw new ClaimsError(`Malformed claims token: ${e.message}`);
    }
    const issuer: string = payload.iss;
    if (!issuer) {
      throw new ClaimsError("Submitted claims must have 'iss'.");
    }
    const key = config.uma.authorization.claimsIssuerKeys[issuer];
    if (!key) {
      throw new ClaimsError(`Unknown issuer ${issuer}.`);
    }
    let claimsPayload: object = {};
    try {
      claimsPayload = jwt.verify(claimsString, key) as object;
    } catch (e) {
      throw new ClaimsError(`Invalid calims token: ${e.message}.`);
    }
    return payload;
  }

  private static validatePermissions(permissions: TimeStampedPermissions): void {
    if (!permissions) {
      throw new InvalidTicketError();
    } else if (permissions.isExpired()) {
      throw new ExpiredTicketError();
    }
  }

  private init(): void {
    this.router.post("/", this.createANewOne);
  }
}