const QUEUES = {
  SR: [400, 420, 430, 440, 490], // Normal Draft, SoloQ, Blind, Flex, Quickplay
  ARAM: [450],
};

const BADGES = [
  // --- BRONZE ---
  {
    key: "ZZZ",
    name: "Zzz",
    description: "Voir son écran noir pendant plus de 7 minutes dans une partie",
    rank: "Bronze",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) => participant.totalTimeSpentDead > 420,
  },
  {
    key: "FULL_STUFF_LOSE",
    name: "Le Banquier Inutile",
    description: "Perdre avec plus de 3000 golds non dépensés",
    rank: "Bronze",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) =>
      participant.goldEarned - participant.goldSpent > 3000,
  },
  {
    key: "EGOISTE",
    name: "L'Égoïste",
    description: "Perdre avec 0 assists",
    rank: "Bronze",
    version: 1,
    repeatable: true,
    trigger: ({ participant, gameDuration }) =>
      gameDuration > 600 && participant.assists === 0,
  },
  {
    key: "VOLEUR",
    name: "Voleur à perte",
    description: "Voler un objectif épique mais perdre",
    rank: "Bronze",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) => participant.objectivesStolen > 0,
    allowed_queues: QUEUES.SR,
  },
  {
    key: "SMITE_VOL",
    name: "Jungle diff",
    description: "Se faire voler un objectif alors que le Smite était disponible",
    rank: "Bronze",
    version: 1,
    repeatable: true,
    trigger: ({ participant, opponentTeamStats }) =>
      participant.teamPosition === "JUNGLE" &&
      opponentTeamStats.participants.some(
        (op) => (op.challenges?.epicMonsterSteals || 0) > 0,
      ),
    allowed_queues: QUEUES.SR,
  },

  // --- ARGENT ---
  {
    key: "5L",
    name: "Jamais 4 sans 5",
    description: "Enchaîner 5 défaites d'affilée",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ streak }) => streak === 5,
  },
  {
    key: "DEMOTION_TIER",
    name: "Le Grand Saut",
    description: "Rétrograder dans un palier inférieur",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ oldTier, newTier, info }) => {
      const q = info?.queueId;
      if (q !== 420 && q !== 440) return false;
      if (!oldTier || !newTier || oldTier === "UNRANKED" || newTier === "UNRANKED") return false;
      const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
      const oldIdx = TIERS.indexOf(oldTier.split(" ")[0].toUpperCase());
      const newIdx = TIERS.indexOf(newTier.split(" ")[0].toUpperCase());
      return oldIdx > -1 && newIdx > -1 && newIdx < oldIdx;
    },
  },
  {
    key: "KDA_PLAYER",
    name: "KDA Player",
    description: "Perdre avec 0 mort et 5+ kills/assists",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) =>
      participant.deaths === 0 &&
      participant.kills + participant.assists >= 5,
  },
  {
    key: "VICTIME",
    name: "Victime",
    description: "Mourir 17 fois ou plus et perdre",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) => participant.deaths >= 17,
  },
  {
    key: "FF",
    name: "FF",
    description: "Perdre en moins de 16 minutes",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ gameDuration }) => gameDuration < 960,
  },
  {
    key: "PROMENEUR",
    name: "Le Promeneur",
    description: "Perdre une partie de plus de 20 min avec moins de 5000 golds gagnés",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ participant, gameDuration }) =>
      gameDuration > 1200 && participant.goldEarned < 5000,
  },
  {
    key: "INGRONIGAUD",
    name: "Ingronigaud",
    description: "Subir plus de 70 000 dégâts et perdre",
    rank: "Argent",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) => participant.totalDamageTaken > 70000,
  },

  // --- OR ---
  {
    key: "ARAM_SNOWBALL",
    name: "Tir aux Pigeons",
    description: "Toucher 15+ boules de neige dans un ARAM et perdre",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ participant }) =>
      (participant.challenges?.snowballHit || 0) >= 15,
    allowed_queues: QUEUES.ARAM,
  },
  {
    key: "STOP_PLZ",
    name: "Stop plz",
    description: "Perdre contre un joueur adverse ayant participé à la destruction de 7 tourelles et 3 inhibiteurs",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ opponentTeamStats }) =>
      opponentTeamStats.participants.some(
        (op) => op.turretTakedowns >= 7 && op.inhibitorTakedowns >= 3,
      ),
    allowed_queues: QUEUES.SR,
  },
  {
    key: "ADIOS",
    name: "Adios",
    description: "Atteindre une série de 10 défaites",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ streak }) => streak === 10,
  },
  {
    key: "ICARE_SYNDROME",
    name: "Le Syndrome d'Icare",
    description: "Perdre en ayant 4000 golds d'avance sur son vis-à-vis",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ participant, opponentDirect }) =>
      opponentDirect &&
      participant.goldEarned - opponentDirect.goldEarned > 4000,
    allowed_queues: QUEUES.SR,
  },
  {
    key: "COURTESY_INHIB",
    name: "L'Inhibiteur de Courtoisie",
    description: "Perdre après avoir détruit un inhibiteur avant la 20ème minute",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ teamStats, gameDuration }) =>
      gameDuration < 1200 && teamStats.inhibitorKills > 0,
    allowed_queues: QUEUES.SR,
  },
  {
    key: "JUNGLE_RIEN",
    name: "Jungler???",
    description: "Terminer une partie de +30 min avec 0 Dragon et 0 Baron pour l'équipe",
    rank: "Or",
    version: 1,
    repeatable: true,
    trigger: ({ participant, teamStats, gameDuration }) =>
      participant.teamPosition === "JUNGLE" &&
      gameDuration > 1800 &&
      teamStats.baronKills === 0 &&
      teamStats.dragonKills === 0,
    allowed_queues: QUEUES.SR,
  },

  // --- PLATINE ---
  {
    key: "PLATINE_V1",
    name: "Maître de la Défaite",
    description: "Posséder tous les badges de défaite de la saison 1 (Bronze à Or)",
    rank: "Platine",
    version: 1,
    repeatable: false,
    trigger: ({ ownedBadgeKeys }) => {
      const v1Badges = BADGES.filter(
        (b) => b.version === 1 && ["Bronze", "Argent", "Or"].includes(b.rank),
      );
      return v1Badges.every((v1) => ownedBadgeKeys.includes(v1.key));
    },
  },

  // --- SECRET ---
  {
    key: "LIFETIME_DEAD_10H",
    name: "Collectionneur de Gris",
    description: "Avoir passé plus de 10 heures mort au total sur tous ses comptes",
    rank: "Secret",
    repeatable: false,
    trigger: ({ totalTimeDead }) => totalTimeDead >= 36000,
  },
  {
    key: "PENTA_LOSE",
    name: "Penta-Lose",
    description: "Faire un Pentakill mais perdre XD",
    rank: "Secret",
    repeatable: true,
    trigger: ({ participant }) => participant.pentaKills > 0,
  },
  {
    key: "FARMING_SIMULATOR",
    name: "Farming-simulator",
    description: "Tuer plus de 400 sbires et perdre",
    rank: "Secret",
    repeatable: true,
    trigger: ({ participant }) =>
      participant.totalMinionsKilled + participant.neutralMinionsKilled > 400,
  },
  {
    key: "BUCHERON",
    name: "Le Bûcheron",
    description: "Participer à la destruction de 11 tourelles et perdre",
    rank: "Secret",
    repeatable: true,
    trigger: ({ participant }) => participant.turretTakedowns >= 11,
    allowed_queues: QUEUES.SR,
  },
  {
    key: "POWERSPIKE_YASUO",
    name: "Powerspike Yasuo",
    description: "Finir la partie avec exactement 0/10/0",
    rank: "Secret",
    repeatable: true,
    trigger: ({ participant }) =>
      participant.kills === 0 &&
      participant.deaths === 10 &&
      participant.assists === 0,
  },
];

// ─── Badges positifs (victoires) ──────────────────────────────────────────────

const WIN_BADGES = [
  // --- BRONZE ---
  {
    key: "FIRST_BLOOD_WIN",
    name: "L'Exécuteur",
    description: "Obtenir le First Blood et gagner",
    rank: "Bronze",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) => participant.firstBloodKill === true,
  },
  {
    key: "EZ",
    name: "Ez",
    description: "Obtenir un KDA d'au moins 4 et gagner",
    rank: "Bronze",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) =>
      participant.deaths === 0
        ? participant.kills + participant.assists >= 4
        : (participant.kills + participant.assists) / participant.deaths >= 4,
  },
  {
    key: "MULTI_KILL_WIN",
    name: "Le Massacreur",
    description: "Réaliser un triple kill ou plus et gagner",
    rank: "Bronze",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) => participant.tripleKills > 0,
  },
  {
    key: "ARAM_SLAYER",
    name: "Aram Slayer",
    description: "Faire 20 kills ou plus en ARAM et gagner",
    rank: "Bronze",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.ARAM,
    trigger: ({ participant }) => participant.kills >= 20,
  },
  {
    key: "WARD_WIN_BRONZE",
    name: "L'Éclaireur",
    description: "Poser 5 pink wards ou plus et gagner",
    rank: "Bronze",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant }) => participant.detectorWardsPlaced >= 5,
  },

  // --- ARGENT ---
  {
    key: "5W",
    name: "Sur une lancée",
    description: "Enchaîner 5 victoires d'affilée",
    rank: "Argent",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ winStreak }) => winStreak === 5,
  },
  {
    key: "VISION_GOD",
    name: "L'Omniscient",
    description: "Gagner une partie avec un score de vision de 80+",
    rank: "Argent",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant }) => participant.visionScore >= 80,
  },
  {
    key: "CHASSEUR_DE_PRIMES",
    name: "Chasseur de Primes",
    description: "Tuer un joueur avec une prime d'au moins 700 golds et gagner",
    rank: "Argent",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) =>
      (participant.challenges?.bountyGold || 0) >= 700,
  },
  {
    key: "KAIZEN",
    name: "Kaizen",
    description: "Monter de palier en ranked et gagner",
    rank: "Argent",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ oldTier, newTier }) => {
      if (!oldTier || !newTier || oldTier === "UNRANKED" || newTier === "UNRANKED") return false;
      const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
      const oldIdx = TIERS.indexOf(oldTier.split(" ")[0].toUpperCase());
      const newIdx = TIERS.indexOf(newTier.split(" ")[0].toUpperCase());
      return oldIdx > -1 && newIdx > -1 && newIdx > oldIdx;
    },
  },
  {
    key: "WINRUN",
    name: "Winrun",
    description: "Gagner une partie en moins de 16 minutes",
    rank: "Argent",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ gameDuration }) => gameDuration < 960,
  },

  // --- OR ---
  {
    key: "1V9",
    name: "1v9",
    description: "Faire 50% ou plus des dégâts de l'équipe et gagner",
    rank: "Or",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) =>
      (participant.challenges?.teamDamagePercentage || 0) >= 0.5,
  },
  {
    key: "INARRETABLE",
    name: "L'Inarrêtable",
    description: "Enchaîner 10 victoires d'affilée",
    rank: "Or",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ winStreak }) => winStreak === 10,
  },
  {
    key: "IMMORTEL",
    name: "L'Immortel",
    description: "Gagner une ARAM sans mourir",
    rank: "Or",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.ARAM,
    trigger: ({ participant }) => participant.deaths === 0,
  },
  {
    key: "INTOMBABLE",
    name: "L'Intombable",
    description: "Subir 80 000 dégâts ou plus et gagner",
    rank: "Or",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) => participant.totalDamageTaken >= 70000,
  },
  {
    key: "SPLITPUSHER",
    name: "Splitpusher",
    description: "Participer à la destruction de 6 tourelles et 3 inhibiteurs et gagner",
    rank: "Or",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant }) =>
      participant.turretTakedowns >= 6 && participant.inhibitorTakedowns >= 3,
  },

  // --- PLATINE ---
  {
    key: "PLATINE_WIN_V1",
    name: "Maître des Victoires",
    description: "Posséder tous les badges de victoire de la saison 1 (Bronze à Or)",
    rank: "Platine",
    version: 1,
    valence: "positive",
    repeatable: false,
    trigger: ({ ownedBadgeKeys }) => {
      const required = [
        "FIRST_BLOOD_WIN", "EZ", "MULTI_KILL_WIN", "ARAM_SLAYER", "WARD_WIN_BRONZE",
        "5W", "VISION_GOD", "CHASSEUR_DE_PRIMES", "KAIZEN", "WINRUN",
        "1V9", "INARRETABLE", "IMMORTEL", "INTOMBABLE", "SPLITPUSHER",
      ];
      return required.every((k) => ownedBadgeKeys.includes(k));
    },
  },

  // --- SECRET ---
  {
    key: "PENTA_WIN",
    name: "Penta-God",
    description: "Faire un Pentakill et gagner",
    rank: "Secret",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) => participant.pentaKills > 0,
  },
  {
    key: "FARMING_WIN",
    name: "La Faucheuse",
    description: "Tuer plus de 400 sbires et gagner",
    rank: "Secret",
    version: 1,
    valence: "positive",
    repeatable: true,
    trigger: ({ participant }) =>
      participant.totalMinionsKilled + participant.neutralMinionsKilled > 400,
  },
  {
    key: "TEAM_DIFF",
    name: "Team diff",
    description: "Gagner avec toute l'équipe ayant au plus 1 mort chacun",
    rank: "Secret",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant, info }) => {
      const teammates = info.participants.filter(
        (p) => p.teamId === participant.teamId,
      );
      return teammates.every((t) => t.deaths <= 1);
    },
  },
  {
    key: "CHASSEUR_DU_NEANT",
    name: "Le chasseur du néant",
    description: "Tuer 3 Barons Nashor dans une partie et gagner",
    rank: "Secret",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant, info }) => {
      const teamStats = info.teams.find((t) => t.teamId === participant.teamId);
      const baronKills =
        teamStats?.objectives?.baron?.kills ?? teamStats?.baronKills ?? 0;
      return baronKills >= 3;
    },
  },
  {
    key: "PLAYER_DIFF",
    name: "Player diff",
    description: "Gagner avec 8000 golds d'écart sur votre vis-à-vis",
    rank: "Secret",
    version: 1,
    valence: "positive",
    repeatable: true,
    allowed_queues: QUEUES.SR,
    trigger: ({ participant, info }) => {
      const opp = info.participants.find(
        (p) =>
          p.teamId !== participant.teamId &&
          p.teamPosition === participant.teamPosition,
      );
      return opp != null && participant.goldEarned - opp.goldEarned >= 8000;
    },
  },

  // --- ASCENDANT ---
  {
    key: "ASCENDANT_V1",
    name: "Le premier ascendant",
    description: "Débloquer TOUS les badges victoires et défaites de la saison 1",
    rank: "Ascendant",
    version: 1,
    valence: "positive",
    repeatable: false,
    trigger: ({ ownedBadgeKeys }) => {
      if (!ownedBadgeKeys.includes("PLATINE_WIN_V1")) return false;
      if (ownedBadgeKeys.includes("PLATINE_V1")) return true;
      const allRequired = BADGES.filter(
        (b) => b.version === 1 && ["Bronze", "Argent", "Or"].includes(b.rank),
      );
      return allRequired.every((b) => ownedBadgeKeys.includes(b.key));
    },
  },
];

function evaluateTriggeredWinBadges(
  participant,
  winStreak,
  info,
  previousLossStreak = 0,
  ownedBadgeKeys = [],
  oldTier = null,
  newTier = null,
) {
  const context = {
    participant,
    streak: winStreak,
    winStreak,
    gameDuration: info.gameDuration,
    info,
    ownedBadgeKeys,
    previousLossStreak,
    oldTier,
    newTier,
    allParticipants: info.participants,
  };

  return WIN_BADGES.filter((badge) => {
    if (badge.allowed_queues && !badge.allowed_queues.includes(info.queueId)) {
      return false;
    }
    if (!badge.repeatable && ownedBadgeKeys.includes(badge.key)) return false;
    return badge.trigger(context);
  });
}

function evaluateTriggeredBadges(
  participant,
  streak,
  info,
  ownedBadgeKeys = [],
  totalTimeDead = 0,
  oldTier = null,
  newTier = null,
) {
  const teamId = participant.teamId;
  const ownTeamStats = info.teams.find((t) => t.teamId === teamId);
  const opponentTeamStats = info.teams.find((t) => t.teamId !== teamId);

  const opponents = info.participants.filter((p) => p.teamId !== teamId);
  const opponentDirect = opponents.find(
    (o) => o.teamPosition === participant.teamPosition,
  );
  const opponentTop = opponents.find((o) => o.teamPosition === "TOP");

  // Inject opponent participants into opponentTeamStats for badges that need them
  opponentTeamStats.participants = opponents;

  const context = {
    participant,
    streak,
    gameDuration: info.gameDuration,
    opponentDirect,
    opponentTop,
    teamStats: ownTeamStats,
    opponentTeamStats: opponentTeamStats,
    allParticipants: info.participants,
    info: info,
    ownedBadgeKeys: ownedBadgeKeys,
    totalTimeDead: totalTimeDead,
    oldTier: oldTier,
    newTier: newTier,
  };

  return BADGES.filter((badge) => {
    if (badge.allowed_queues && !badge.allowed_queues.includes(info.queueId)) {
      return false;
    }
    return badge.trigger(context);
  });
}

module.exports = {
  BADGES,
  WIN_BADGES,
  evaluateTriggeredBadges,
  evaluateTriggeredWinBadges,
};
