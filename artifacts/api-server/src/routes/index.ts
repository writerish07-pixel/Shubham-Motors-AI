import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leadsRouter from "./leads";
import callsRouter from "./calls";
import knowledgeRouter from "./knowledge";
import followupsRouter from "./followups";
import analyticsRouter from "./analytics";
import webhooksRouter from "./webhooks";
import schedulerRouter from "./scheduler";
import campaignsRouter from "./campaigns";
import contactsRouter from "./contacts";
import visitsRouter from "./visits";
import shadowRouter from "./shadow";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(knowledgeRouter);
router.use(followupsRouter);
router.use(analyticsRouter);
router.use(webhooksRouter);
router.use(schedulerRouter);
router.use(campaignsRouter);
router.use(contactsRouter);
router.use(visitsRouter);
router.use(shadowRouter);

export default router;
