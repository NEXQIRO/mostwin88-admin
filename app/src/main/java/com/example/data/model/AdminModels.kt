package com.example.data.model

data class AdminProfile(
    val uid: String = "",
    val email: String = "",
    val name: String = "Admin",
    val role: String = "ADMIN", // MASTER_ADMIN, ADMIN, AGENT, AFFILIATE, PLAYER
    val parentAdminId: String = "hQvneUu3e0SJWgfOtIoqaDeltt92",
    val status: String = "active", // active, inactive, suspended
    val balance: Double = 0.0,
    val allocatedAgentFund: Double = 0.0,
    val active: Boolean = true,
    val createdAt: Long = System.currentTimeMillis()
)

data class FundLedgerEntry(
    val trxId: String = "",
    val type: String = "", // MASTER_GRANT, AGENT_ALLOCATE, AGENT_RETRIEVE, WITHDRAWAL_SETTLEMENT, DEPOSIT_CREDIT
    val amount: Double = 0.0,
    val beforeBalance: Double = 0.0,
    val afterBalance: Double = 0.0,
    val sourceUid: String = "",
    val targetUid: String = "",
    val targetName: String = "",
    val note: String = "",
    val timestamp: Long = System.currentTimeMillis()
)

data class FundRequest(
    val id: String = "",
    val adminUid: String = "",
    val adminEmail: String = "",
    val amount: Double = 0.0,
    val reason: String = "",
    val status: String = "pending", // pending, approved, rejected
    val createdAt: Long = System.currentTimeMillis(),
    val approvedAt: Long? = null
)

data class Agent(
    val id: String = "",
    val parentAdminId: String = "",
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val paymentNumbers: Map<String, String> = emptyMap(), // bKash, Nagad, Rocket
    val balance: Double = 0.0,
    val status: String = "active", // active, inactive, suspended
    val totalProcessedDeposits: Double = 0.0,
    val totalProcessedWithdrawals: Double = 0.0,
    val createdAt: Long = System.currentTimeMillis()
)

data class Affiliate(
    val id: String = "",
    val parentAdminId: String = "",
    val name: String = "",
    val email: String = "",
    val referralCode: String = "",
    val referralLink: String = "",
    val totalReferredPlayers: Int = 0,
    val totalCommission: Double = 0.0,
    val status: String = "active", // active, inactive
    val createdAt: Long = System.currentTimeMillis()
)

data class Player(
    val id: String = "",
    val parentAdminId: String = "",
    val assignedAgentId: String = "",
    val affiliateId: String? = null,
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val gameUid: String = "",
    val walletBalance: Double = 0.0,
    val bonusBalance: Double = 0.0,
    val totalDeposited: Double = 0.0,
    val totalWithdrawn: Double = 0.0,
    val status: String = "active", // active, suspended
    val createdAt: Long = System.currentTimeMillis()
)

data class DepositRequest(
    val id: String = "",
    val playerId: String = "",
    val playerName: String = "",
    val parentAdminId: String = "",
    val assignedAgentId: String = "",
    val assignedAgentName: String = "",
    val amount: Double = 0.0,
    val method: String = "bKash", // bKash, Nagad, Rocket
    val senderNumber: String = "",
    val trxId: String = "",
    val status: String = "Pending", // Pending, Approved, Rejected (Admin only monitors; Agent verifies)
    val createdAt: Long = System.currentTimeMillis(),
    val verifiedAt: Long? = null
)

data class WithdrawalRequest(
    val id: String = "",
    val playerId: String = "",
    val playerName: String = "",
    val parentAdminId: String = "",
    val assignedAgentId: String = "",
    val assignedAgentName: String = "",
    val amount: Double = 0.0,
    val method: String = "bKash",
    val receiverNumber: String = "",
    val playerCurrentBalance: Double = 0.0,
    val status: String = "Pending", // Pending, AssignedToAgent, Processing, Completed, Rejected
    val agentTrxId: String = "",
    val createdAt: Long = System.currentTimeMillis(),
    val processedAt: Long? = null
)

data class CasinoGame(
    val id: String = "",
    val name: String = "",
    val category: String = "Crash Games",
    val status: String = "Active",
    val activePlayers: Int = 0,
    val totalBetsToday: Double = 0.0,
    val rtpPercent: Double = 96.5
)

data class Promotion(
    val id: String = "",
    val title: String = "",
    val bonusPercentage: Double = 10.0,
    val minDeposit: Double = 100.0,
    val turnoverMultiplier: Double = 2.0,
    val status: String = "Active", // Active, Inactive
    val bannerText: String = ""
)

data class AppNotification(
    val id: String = "",
    val title: String = "",
    val message: String = "",
    val target: String = "ALL", // ALL, AGENTS, PLAYERS
    val timestamp: Long = System.currentTimeMillis()
)

data class ChatMessage(
    val id: String = "",
    val senderId: String = "",
    val senderName: String = "",
    val senderRole: String = "ADMIN", // ADMIN, AGENT, MASTER_ADMIN
    val message: String = "",
    val timestamp: Long = System.currentTimeMillis()
)
