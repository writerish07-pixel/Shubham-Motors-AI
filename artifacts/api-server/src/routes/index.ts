import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leadsRouter from "./leads";
import callsRouter from "./calls";
import knowledgeRouter from "./knowledge";
import followupsRouter from "./followups";
import analyticsRouter from "./analytics";
import webhooksRouter from "./webhooks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(knowledgeRouter);
router.use(followupsRouter);
router.use(analyticsRouter);
router.use(webhooksRouter);

export default router;
