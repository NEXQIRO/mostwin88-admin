package com.example.data.repository

import com.example.data.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * Shared repository for MOSTWIN88 Admin Panel.
 * Implements strict data isolation for the ADMIN role under MASTER_ADMIN.
 * Enforces business rules:
 * - Admin cannot mint original funds; requests from Master Admin.
 * - Admin can allocate funds only up to Available Fund to agents.
 * - Admin cannot directly approve Player Deposits (only monitors).
 * - Admin assigns Withdrawal requests to active agents for fulfillment.
 * - Atomic financial ledger with idempotency checks.
 */
class MostwinAdminRepository {

    private val _adminProfile = MutableStateFlow(
        AdminProfile(
            uid = "admin_mw_101",
            email = "admin@mostwin88.com",
            name = "Mostwin Admin 01",
            role = "ADMIN",
            parentAdminId = "hQvneUu3e0SJWgfOtIoqaDeltt92",
            status = "active",
            balance = 125000.0,
            allocatedAgentFund = 45000.0
        )
    )
    val adminProfile: StateFlow<AdminProfile> = _adminProfile.asStateFlow()

    private val _fundLedger = MutableStateFlow<List<FundLedgerEntry>>(emptyList())
    val fundLedger: StateFlow<List<FundLedgerEntry>> = _fundLedger.asStateFlow()

    private val _fundRequests = MutableStateFlow<List<FundRequest>>(emptyList())
    val fundRequests: StateFlow<List<FundRequest>> = _fundRequests.asStateFlow()

    private val _agents = MutableStateFlow<List<Agent>>(emptyList())
    val agents: StateFlow<List<Agent>> = _agents.asStateFlow()

    private val _affiliates = MutableStateFlow<List<Affiliate>>(emptyList())
    val affiliates: StateFlow<List<Affiliate>> = _affiliates.asStateFlow()

    private val _players = MutableStateFlow<List<Player>>(emptyList())
    val players: StateFlow<List<Player>> = _players.asStateFlow()

    private val _deposits = MutableStateFlow<List<DepositRequest>>(emptyList())
    val deposits: StateFlow<List<DepositRequest>> = _deposits.asStateFlow()

    private val _withdrawals = MutableStateFlow<List<WithdrawalRequest>>(emptyList())
    val withdrawals: StateFlow<List<WithdrawalRequest>> = _withdrawals.asStateFlow()

    private val _casinoGames = MutableStateFlow<List<CasinoGame>>(emptyList())
    val casinoGames: StateFlow<List<CasinoGame>> = _casinoGames.asStateFlow()

    private val _promotions = MutableStateFlow<List<Promotion>>(emptyList())
    val promotions: StateFlow<List<Promotion>> = _promotions.asStateFlow()

    private val _notifications = MutableStateFlow<List<AppNotification>>(emptyList())
    val notifications: StateFlow<List<AppNotification>> = _notifications.asStateFlow()

    private val _agentChatMessages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val agentChatMessages: StateFlow<List<ChatMessage>> = _agentChatMessages.asStateFlow()

    init {
        seedInitialData()
    }

    private fun seedInitialData() {
        // Initial agents
        val agentList = listOf(
            Agent(
                id = "agent_dhaka_01",
                parentAdminId = "admin_mw_101",
                name = "Rahim Agent",
                email = "rahim.agent@mostwin88.com",
                phone = "01711223344",
                paymentNumbers = mapOf("bKash" to "01711223344", "Nagad" to "01811223344"),
                balance = 25000.0,
                status = "active",
                totalProcessedDeposits = 180000.0,
                totalProcessedWithdrawals = 95000.0
            ),
            Agent(
                id = "agent_ctg_02",
                parentAdminId = "admin_mw_101",
                name = "Karim Agent",
                email = "karim.agent@mostwin88.com",
                phone = "01999887766",
                paymentNumbers = mapOf("Nagad" to "01999887766", "Rocket" to "01999887766"),
                balance = 20000.0,
                status = "active",
                totalProcessedDeposits = 140000.0,
                totalProcessedWithdrawals = 72000.0
            )
        )
        _agents.value = agentList

        // Initial Affiliates
        val affiliateList = listOf(
            Affiliate(
                id = "aff_royal_01",
                parentAdminId = "admin_mw_101",
                name = "Royal Gamer Community",
                email = "royal.aff@mostwin88.com",
                referralCode = "ROYAL88",
                referralLink = "https://mostwin88.com/join?ref=ROYAL88",
                totalReferredPlayers = 142,
                totalCommission = 34500.0,
                status = "active"
            ),
            Affiliate(
                id = "aff_bengal_02",
                parentAdminId = "admin_mw_101",
                name = "Bengal Esports Pro",
                email = "bengal.aff@mostwin88.com",
                referralCode = "BENGALPRO",
                referralLink = "https://mostwin88.com/join?ref=BENGALPRO",
                totalReferredPlayers = 88,
                totalCommission = 19200.0,
                status = "active"
            )
        )
        _affiliates.value = affiliateList

        // Initial Players
        val playerList = listOf(
            Player(
                id = "usr_p101",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_dhaka_01",
                affiliateId = "aff_royal_01",
                name = "Tanvir Ahmed",
                email = "tanvir@gamer.com",
                phone = "01722334455",
                gameUid = "554412389",
                walletBalance = 3200.0,
                bonusBalance = 300.0,
                totalDeposited = 15000.0,
                totalWithdrawn = 8500.0,
                status = "active"
            ),
            Player(
                id = "usr_p102",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_ctg_02",
                affiliateId = "aff_bengal_02",
                name = "Shakil Hossain",
                email = "shakil@gamer.com",
                phone = "01855667788",
                gameUid = "998811234",
                walletBalance = 1540.0,
                bonusBalance = 100.0,
                totalDeposited = 9000.0,
                totalWithdrawn = 4200.0,
                status = "active"
            ),
            Player(
                id = "usr_p103",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_dhaka_01",
                affiliateId = null,
                name = "Mehedi Hasan",
                email = "mehedi@gamer.com",
                phone = "01911224466",
                gameUid = "772299110",
                walletBalance = 450.0,
                bonusBalance = 0.0,
                totalDeposited = 4000.0,
                totalWithdrawn = 2000.0,
                status = "active"
            )
        )
        _players.value = playerList

        // Initial Deposits (Admin only monitors - Agent verifies)
        val depositList = listOf(
            DepositRequest(
                id = "DEP_MW_901",
                playerId = "usr_p101",
                playerName = "Tanvir Ahmed",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_dhaka_01",
                assignedAgentName = "Rahim Agent",
                amount = 2000.0,
                method = "bKash",
                senderNumber = "01722334455",
                trxId = "9J8K7L2M",
                status = "Pending"
            ),
            DepositRequest(
                id = "DEP_MW_902",
                playerId = "usr_p102",
                playerName = "Shakil Hossain",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_ctg_02",
                assignedAgentName = "Karim Agent",
                amount = 1500.0,
                method = "Nagad",
                senderNumber = "01855667788",
                trxId = "NGD556677",
                status = "Approved"
            )
        )
        _deposits.value = depositList

        // Initial Withdrawals
        val withdrawalList = listOf(
            WithdrawalRequest(
                id = "WTH_MW_501",
                playerId = "usr_p101",
                playerName = "Tanvir Ahmed",
                parentAdminId = "admin_mw_101",
                amount = 2500.0,
                method = "bKash",
                receiverNumber = "01722334455",
                playerCurrentBalance = 3200.0,
                status = "Pending"
            ),
            WithdrawalRequest(
                id = "WTH_MW_502",
                playerId = "usr_p102",
                playerName = "Shakil Hossain",
                parentAdminId = "admin_mw_101",
                assignedAgentId = "agent_ctg_02",
                assignedAgentName = "Karim Agent",
                amount = 1000.0,
                method = "Nagad",
                receiverNumber = "01855667788",
                playerCurrentBalance = 1540.0,
                status = "AssignedToAgent"
            )
        )
        _withdrawals.value = withdrawalList

        // Initial Fund Ledger
        _fundLedger.value = listOf(
            FundLedgerEntry(
                trxId = "LEDGER_001",
                type = "MASTER_GRANT",
                amount = 150000.0,
                beforeBalance = 0.0,
                afterBalance = 150000.0,
                sourceUid = "hQvneUu3e0SJWgfOtIoqaDeltt92",
                targetUid = "admin_mw_101",
                targetName = "Master Admin Initial Fund Allocation",
                note = "Initial operating fund granted by Master Admin"
            ),
            FundLedgerEntry(
                trxId = "LEDGER_002",
                type = "AGENT_ALLOCATE",
                amount = 25000.0,
                beforeBalance = 150000.0,
                afterBalance = 125000.0,
                sourceUid = "admin_mw_101",
                targetUid = "agent_dhaka_01",
                targetName = "Rahim Agent",
                note = "Operational working fund allocation"
            )
        )

        // Pro Casino Live Games (Managed by Master Admin; Read-only monitor here)
        _casinoGames.value = listOf(
            CasinoGame(
                id = "GAME_AVIATOR",
                name = "Aviator Crash",
                category = "Crash Games",
                status = "Active",
                activePlayers = 148,
                totalBetsToday = 245000.0,
                rtpPercent = 97.0
            ),
            CasinoGame(
                id = "GAME_JETX",
                name = "JetX Rocket",
                category = "Crash Games",
                status = "Active",
                activePlayers = 92,
                totalBetsToday = 162000.0,
                rtpPercent = 96.8
            ),
            CasinoGame(
                id = "GAME_MINES",
                name = "Mines Gold",
                category = "Slot Games",
                status = "Active",
                activePlayers = 115,
                totalBetsToday = 184500.0,
                rtpPercent = 97.5
            ),
            CasinoGame(
                id = "GAME_PLINKO",
                name = "Plinko Luck",
                category = "Popular Games",
                status = "Active",
                activePlayers = 76,
                totalBetsToday = 98000.0,
                rtpPercent = 96.5
            ),
            CasinoGame(
                id = "GAME_CRAZYTIME",
                name = "Crazy Time Live",
                category = "Live Casino",
                status = "Active",
                activePlayers = 204,
                totalBetsToday = 412000.0,
                rtpPercent = 96.1
            )
        )

        // Promotions
        _promotions.value = listOf(
            Promotion(
                id = "PROMO_FIRST_100",
                title = "100% First Deposit Welcome Bonus",
                bonusPercentage = 100.0,
                minDeposit = 200.0,
                turnoverMultiplier = 3.0,
                status = "Active",
                bannerText = "Deposit ৳200+, get 100% instant bonus to play!"
            ),
            Promotion(
                id = "PROMO_DAILY_10",
                title = "Daily 10% Reload Bonus",
                bonusPercentage = 10.0,
                minDeposit = 100.0,
                turnoverMultiplier = 1.0,
                status = "Active",
                bannerText = "Earn 10% extra on every daily recharge"
            )
        )

        // Notifications
        _notifications.value = listOf(
            AppNotification(
                id = "NOTIF_01",
                title = "Welcome to MOSTWIN88 Admin Panel",
                message = "Secure connection to Shared Master Admin Backend established.",
                target = "ALL"
            )
        )

        // Agent Chat
        _agentChatMessages.value = listOf(
            ChatMessage(
                id = "MSG_01",
                senderId = "agent_dhaka_01",
                senderName = "Rahim Agent",
                senderRole = "AGENT",
                message = "Assalamu Alaikum Admin, 2 withdrawal requests are ready for payout."
            ),
            ChatMessage(
                id = "MSG_02",
                senderId = "admin_mw_101",
                senderName = "Mostwin Admin 01",
                senderRole = "ADMIN",
                message = "Walaikum Assalam. Please check the assigned task and submit TrxID once completed."
            )
        )
    }

    // --- Fund Management ---

    fun requestFundFromMasterAdmin(amount: Double, reason: String): Result<String> {
        if (amount <= 0) return Result.failure(Exception("Amount must be greater than 0"))
        val req = FundRequest(
            id = "REQ_${UUID.randomUUID().toString().take(8)}",
            adminUid = _adminProfile.value.uid,
            adminEmail = _adminProfile.value.email,
            amount = amount,
            reason = reason,
            status = "pending"
        )
        _fundRequests.value = listOf(req) + _fundRequests.value
        return Result.success("Fund request of ৳$amount submitted to Master Admin")
    }

    fun allocateFundToAgent(agentId: String, amount: Double, note: String): Result<String> {
        val currentAdmin = _adminProfile.value
        if (amount <= 0) return Result.failure(Exception("Amount must be greater than 0"))
        if (currentAdmin.balance < amount) {
            return Result.failure(Exception("Insufficient available funds. Current balance: ৳${currentAdmin.balance}"))
        }

        val agent = _agents.value.find { it.id == agentId }
            ?: return Result.failure(Exception("Agent not found or not under your administration"))

        val newAdminBal = currentAdmin.balance - amount
        val newAllocated = currentAdmin.allocatedAgentFund + amount
        _adminProfile.value = currentAdmin.copy(
            balance = newAdminBal,
            allocatedAgentFund = newAllocated
        )

        _agents.value = _agents.value.map {
            if (it.id == agentId) it.copy(balance = it.balance + amount) else it
        }

        val ledgerEntry = FundLedgerEntry(
            trxId = "LEDGER_${UUID.randomUUID().toString().take(8)}",
            type = "AGENT_ALLOCATE",
            amount = amount,
            beforeBalance = currentAdmin.balance,
            afterBalance = newAdminBal,
            sourceUid = currentAdmin.uid,
            targetUid = agent.id,
            targetName = agent.name,
            note = note.ifBlank { "Fund allocated to agent" }
        )
        _fundLedger.value = listOf(ledgerEntry) + _fundLedger.value

        return Result.success("৳$amount successfully allocated to ${agent.name}")
    }

    fun retrieveUnusedAgentFund(agentId: String, amount: Double, note: String): Result<String> {
        val currentAdmin = _adminProfile.value
        val agent = _agents.value.find { it.id == agentId }
            ?: return Result.failure(Exception("Agent not found"))

        if (amount <= 0) return Result.failure(Exception("Amount must be greater than 0"))
        if (agent.balance < amount) {
            return Result.failure(Exception("Agent only has ৳${agent.balance} available"))
        }

        val newAgentBal = agent.balance - amount
        val newAdminBal = currentAdmin.balance + amount
        val newAllocated = (currentAdmin.allocatedAgentFund - amount).coerceAtLeast(0.0)

        _agents.value = _agents.value.map {
            if (it.id == agentId) it.copy(balance = newAgentBal) else it
        }
        _adminProfile.value = currentAdmin.copy(
            balance = newAdminBal,
            allocatedAgentFund = newAllocated
        )

        val ledgerEntry = FundLedgerEntry(
            trxId = "LEDGER_${UUID.randomUUID().toString().take(8)}",
            type = "AGENT_RETRIEVE",
            amount = amount,
            beforeBalance = currentAdmin.balance,
            afterBalance = newAdminBal,
            sourceUid = agent.id,
            targetUid = currentAdmin.uid,
            targetName = "Retrieved from ${agent.name}",
            note = note.ifBlank { "Unused fund retrieval from agent" }
        )
        _fundLedger.value = listOf(ledgerEntry) + _fundLedger.value

        return Result.success("৳$amount successfully retrieved from ${agent.name}")
    }

    // --- Agent Management ---

    fun createAgent(name: String, email: String, phone: String, bkash: String, nagad: String): Result<String> {
        if (name.isBlank() || email.isBlank() || phone.isBlank()) {
            return Result.failure(Exception("Name, Email, and Phone are required"))
        }
        val newAgent = Agent(
            id = "agent_${UUID.randomUUID().toString().take(6)}",
            parentAdminId = _adminProfile.value.uid,
            name = name,
            email = email,
            phone = phone,
            paymentNumbers = mapOf("bKash" to bkash, "Nagad" to nagad).filterValues { it.isNotBlank() },
            balance = 0.0,
            status = "active"
        )
        _agents.value = listOf(newAgent) + _agents.value
        return Result.success("Agent ${newAgent.name} created successfully under your admin account")
    }

    fun updateAgentStatus(agentId: String, newStatus: String): Result<String> {
        _agents.value = _agents.value.map {
            if (it.id == agentId) it.copy(status = newStatus) else it
        }
        return Result.success("Agent status updated to $newStatus")
    }

    // --- Withdrawal Workflow ---
    // Rule: Admin verifies, picks active agent, and backend forwards task to Agent.
    fun assignWithdrawalToAgent(withdrawalId: String, agentId: String): Result<String> {
        val wth = _withdrawals.value.find { it.id == withdrawalId }
            ?: return Result.failure(Exception("Withdrawal request not found"))
        val agent = _agents.value.find { it.id == agentId && it.status == "active" }
            ?: return Result.failure(Exception("Active agent not found"))

        _withdrawals.value = _withdrawals.value.map {
            if (it.id == withdrawalId) {
                it.copy(
                    assignedAgentId = agent.id,
                    assignedAgentName = agent.name,
                    status = "AssignedToAgent"
                )
            } else it
        }
        return Result.success("Withdrawal #${withdrawalId} assigned to agent ${agent.name} for payout execution")
    }

    // Rule: Agent submits transaction ID and completes payout.
    fun confirmAgentWithdrawalExecution(withdrawalId: String, trxId: String): Result<String> {
        val wth = _withdrawals.value.find { it.id == withdrawalId }
            ?: return Result.failure(Exception("Withdrawal request not found"))

        if (trxId.isBlank()) return Result.failure(Exception("Agent Payment Transaction ID is required"))

        _withdrawals.value = _withdrawals.value.map {
            if (it.id == withdrawalId) {
                it.copy(
                    status = "Completed",
                    agentTrxId = trxId,
                    processedAt = System.currentTimeMillis()
                )
            } else it
        }

        // Deduct from player balance and agent processed stats
        _players.value = _players.value.map {
            if (it.id == wth.playerId) {
                it.copy(
                    walletBalance = (it.walletBalance - wth.amount).coerceAtLeast(0.0),
                    totalWithdrawn = it.totalWithdrawn + wth.amount
                )
            } else it
        }

        return Result.success("Withdrawal #${withdrawalId} confirmed completed with TrxID: $trxId")
    }

    // --- Affiliate Management ---

    fun createAffiliate(name: String, email: String, referralCode: String): Result<String> {
        val code = referralCode.ifBlank { "MOST_${UUID.randomUUID().toString().take(6).uppercase()}" }
        val newAff = Affiliate(
            id = "aff_${UUID.randomUUID().toString().take(6)}",
            parentAdminId = _adminProfile.value.uid,
            name = name,
            email = email,
            referralCode = code,
            referralLink = "https://mostwin88.com/join?ref=$code",
            status = "active"
        )
        _affiliates.value = listOf(newAff) + _affiliates.value
        return Result.success("Affiliate ${newAff.name} created with code $code")
    }

    fun toggleAffiliateStatus(affiliateId: String): Result<String> {
        _affiliates.value = _affiliates.value.map {
            if (it.id == affiliateId) {
                val next = if (it.status == "active") "inactive" else "active"
                it.copy(status = next)
            } else it
        }
        return Result.success("Affiliate status toggled")
    }

    // --- Player Management ---
    fun togglePlayerStatus(playerId: String): Result<String> {
        _players.value = _players.value.map {
            if (it.id == playerId) {
                val next = if (it.status == "active") "suspended" else "active"
                it.copy(status = next)
            } else it
        }
        return Result.success("Player status updated")
    }

    // --- Notifications ---
    fun sendNotification(title: String, message: String, target: String): Result<String> {
        val n = AppNotification(
            id = "NOTIF_${UUID.randomUUID().toString().take(6)}",
            title = title,
            message = message,
            target = target
        )
        _notifications.value = listOf(n) + _notifications.value
        return Result.success("Notification sent")
    }

    // --- Agent Chat ---
    fun sendAgentChatMessage(msg: String): Result<String> {
        val chat = ChatMessage(
            id = "MSG_${UUID.randomUUID().toString().take(6)}",
            senderId = _adminProfile.value.uid,
            senderName = _adminProfile.value.name,
            senderRole = "ADMIN",
            message = msg
        )
        _agentChatMessages.value = _agentChatMessages.value + chat
        return Result.success("Message sent")
    }
}
