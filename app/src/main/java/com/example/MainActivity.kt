package com.example

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.data.repository.MostwinAdminRepository
import com.example.ui.components.Mostwin88Logo
import com.example.ui.screens.*
import com.example.ui.theme.*
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val repository = MostwinAdminRepository()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            var isDarkTheme by remember { mutableStateOf(true) }
            var currentLanguage by remember { mutableStateOf("EN") } // "EN" or "BN"

            Mostwin88AdminTheme(darkTheme = isDarkTheme) {
                AdminApp(
                    repository = repository,
                    isDarkTheme = isDarkTheme,
                    currentLanguage = currentLanguage,
                    onToggleTheme = { isDarkTheme = !isDarkTheme },
                    onToggleLanguage = { currentLanguage = if (currentLanguage == "EN") "BN" else "EN" }
                )
            }
        }
    }
}

enum class AdminNavDestination(val labelEn: String, val labelBn: String, val icon: ImageVector) {
    DASHBOARD("Dashboard", "ড্যাশবোর্ড", Icons.Default.Dashboard),
    FUND_MANAGEMENT("Fund Management", "ফান্ড ম্যানেজমেন্ট", Icons.Default.AccountBalanceWallet),
    AGENTS("Agents", "এজেন্ট বৃন্দ", Icons.Default.SupportAgent),
    WITHDRAWALS("Withdrawals", "উইথড্র রিকোয়েস্ট", Icons.Default.Payments),
    DEPOSITS("Deposits Monitor", "ডিপোজিট মনিটর", Icons.Default.Paid),
    AFFILIATES("Affiliates", "অ্যাফিলিয়েট", Icons.Default.Share),
    PLAYERS("Players", "প্লেয়ার বৃন্দ", Icons.Default.People),
    CASINO_GAMES("Casino Games", "ক্যাসিনো গেমস", Icons.Default.Casino),
    MESSAGES("Chat & Notices", "মেসেজ ও নোটিশ", Icons.Default.Notifications),
    REPORTS("Reports", "রিপোর্ট", Icons.Default.Assessment),
    SETTINGS("Settings", "সেটিংস", Icons.Default.Settings)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminApp(
    repository: MostwinAdminRepository,
    isDarkTheme: Boolean,
    currentLanguage: String,
    onToggleTheme: () -> Unit,
    onToggleLanguage: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)

    var isLoggedIn by remember { mutableStateOf(true) }
    var currentDestination by remember { mutableStateOf(AdminNavDestination.DASHBOARD) }

    // State flows from repository
    val adminProfile by repository.adminProfile.collectAsStateWithLifecycle()
    val agents by repository.agents.collectAsStateWithLifecycle()
    val affiliates by repository.affiliates.collectAsStateWithLifecycle()
    val players by repository.players.collectAsStateWithLifecycle()
    val deposits by repository.deposits.collectAsStateWithLifecycle()
    val withdrawals by repository.withdrawals.collectAsStateWithLifecycle()
    val ledger by repository.fundLedger.collectAsStateWithLifecycle()
    val casinoGames by repository.casinoGames.collectAsStateWithLifecycle()
    val notifications by repository.notifications.collectAsStateWithLifecycle()
    val chatMessages by repository.agentChatMessages.collectAsStateWithLifecycle()

    var showQuickFundRequestModal by remember { mutableStateOf(false) }

    // Android back navigation support
    BackHandler(enabled = currentDestination != AdminNavDestination.DASHBOARD && isLoggedIn) {
        currentDestination = AdminNavDestination.DASHBOARD
    }

    if (!isLoggedIn) {
        LoginScreen(
            onLoginSuccess = { email ->
                isLoggedIn = true
                Toast.makeText(context, "Welcome $email", Toast.LENGTH_SHORT).show()
            }
        )
        return
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = BgSurface,
                drawerContentColor = TextPrimary,
                modifier = Modifier.width(310.dp)
            ) {
                // Drawer Header
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(BgCard)
                        .padding(20.dp)
                ) {
                    Mostwin88Logo(isSmall = true)
                    Spacer(modifier = Modifier.height(14.dp))
                    Text(
                        text = adminProfile.name,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    Text(
                        text = adminProfile.email,
                        color = TextMuted,
                        fontSize = 12.sp
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Surface(
                        color = GoldPrimary.copy(alpha = 0.15f),
                        shape = RoundedCornerShape(6.dp),
                        border = androidx.compose.foundation.BorderStroke(0.5.dp, GoldBorder)
                    ) {
                        Text(
                            text = "ROLE: ${adminProfile.role} • PARENT: MASTER ADMIN",
                            color = GoldPrimary,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                        )
                    }
                }

                HorizontalDivider(color = BgBorder)

                // Navigation Items
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(8.dp)
                ) {
                    AdminNavDestination.entries.forEach { dest ->
                        val selected = currentDestination == dest
                        NavigationDrawerItem(
                            label = {
                                Text(
                                    text = if (currentLanguage == "BN") dest.labelBn else dest.labelEn,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
                                )
                            },
                            icon = {
                                Icon(
                                    imageVector = dest.icon,
                                    contentDescription = dest.labelEn,
                                    tint = if (selected) GoldPrimary else TextMuted
                                )
                            },
                            selected = selected,
                            onClick = {
                                currentDestination = dest
                                coroutineScope.launch { drawerState.close() }
                            },
                            colors = NavigationDrawerItemDefaults.colors(
                                selectedContainerColor = GoldPrimary.copy(alpha = 0.16f),
                                unselectedContainerColor = Color.Transparent,
                                selectedTextColor = GoldPrimary,
                                unselectedTextColor = TextPrimary
                            ),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier
                                .padding(vertical = 2.dp)
                                .testTag("nav_item_${dest.name.lowercase()}")
                        )
                    }
                }

                HorizontalDivider(color = BgBorder)

                // Bottom Logout & Theme info
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        modifier = Modifier
                            .clickable {
                                isLoggedIn = false
                                Toast.makeText(context, "Logged out successfully", Toast.LENGTH_SHORT).show()
                            }
                            .padding(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                            contentDescription = "Logout",
                            tint = AccentRed,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = if (currentLanguage == "BN") "লগআউট" else "Logout",
                            color = AccentRed,
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                    }

                    // Lang badge
                    Surface(
                        color = GoldBorder.copy(alpha = 0.3f),
                        shape = RoundedCornerShape(6.dp),
                        modifier = Modifier.clickable { onToggleLanguage() }
                    ) {
                        Text(
                            text = currentLanguage,
                            color = GoldPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                        )
                    }
                }
            }
        }
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = if (currentLanguage == "BN") currentDestination.labelBn else currentDestination.labelEn,
                                fontSize = 17.sp,
                                fontWeight = FontWeight.Bold,
                                color = TextPrimary
                            )
                        }
                    },
                    navigationIcon = {
                        if (currentDestination != AdminNavDestination.DASHBOARD) {
                            IconButton(
                                onClick = { currentDestination = AdminNavDestination.DASHBOARD },
                                modifier = Modifier.testTag("topbar_back_button")
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = "Back",
                                    tint = GoldPrimary
                                )
                            }
                        } else {
                            IconButton(
                                onClick = { coroutineScope.launch { drawerState.open() } },
                                modifier = Modifier.testTag("topbar_menu_button")
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Menu,
                                    contentDescription = "Menu",
                                    tint = GoldPrimary
                                )
                            }
                        }
                    },
                    actions = {
                        // Quick balance pill with + Fund button
                        Surface(
                            shape = RoundedCornerShape(20.dp),
                            color = BgCard,
                            border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder),
                            modifier = Modifier
                                .padding(end = 4.dp)
                                .clickable { showQuickFundRequestModal = true }
                                .testTag("topbar_balance_pill")
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "৳%,d".format(adminProfile.balance.toLong()),
                                    color = GoldPrimary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Icon(
                                    imageVector = Icons.Default.AddCircle,
                                    contentDescription = "Request Fund",
                                    tint = GoldPrimary,
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                        }

                        // Notification alert indicator
                        IconButton(
                            onClick = { currentDestination = AdminNavDestination.MESSAGES },
                            modifier = Modifier.testTag("topbar_notifications_button")
                        ) {
                            BadgedBox(badge = {
                                Badge(containerColor = AccentRed) {
                                    Text(
                                        text = "${notifications.size + chatMessages.size}",
                                        fontSize = 9.sp
                                    )
                                }
                            }) {
                                Icon(
                                    imageVector = Icons.Default.Notifications,
                                    contentDescription = "Notifications",
                                    tint = TextSecondary
                                )
                            }
                        }

                        // Language Toggle Icon
                        IconButton(
                            onClick = { onToggleLanguage() },
                            modifier = Modifier.testTag("topbar_lang_button")
                        ) {
                            Text(
                                text = currentLanguage,
                                color = GoldPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = BgSurface,
                        titleContentColor = TextPrimary
                    )
                )
            },
            bottomBar = {
                // Bottom Quick Access Bar for 4 core operational screens
                NavigationBar(
                    containerColor = BgSurface,
                    contentColor = TextPrimary,
                    tonalElevation = 8.dp
                ) {
                    val quickDestinations = listOf(
                        AdminNavDestination.DASHBOARD,
                        AdminNavDestination.FUND_MANAGEMENT,
                        AdminNavDestination.AGENTS,
                        AdminNavDestination.WITHDRAWALS,
                        AdminNavDestination.SETTINGS
                    )

                    quickDestinations.forEach { dest ->
                        val selected = currentDestination == dest
                        NavigationBarItem(
                            selected = selected,
                            onClick = { currentDestination = dest },
                            icon = {
                                Icon(
                                    imageVector = dest.icon,
                                    contentDescription = dest.labelEn,
                                    tint = if (selected) GoldPrimary else TextMuted
                                )
                            },
                            label = {
                                Text(
                                    text = if (currentLanguage == "BN") dest.labelBn else dest.labelEn,
                                    fontSize = 10.sp,
                                    color = if (selected) GoldPrimary else TextMuted,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = GoldPrimary.copy(alpha = 0.15f)
                            ),
                            modifier = Modifier.testTag("bottom_nav_${dest.name.lowercase()}")
                        )
                    }
                }
            },
            containerColor = BgBase
        ) { paddingValues ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                when (currentDestination) {
                    AdminNavDestination.DASHBOARD -> DashboardScreen(
                        adminProfile = adminProfile,
                        agents = agents,
                        affiliates = affiliates,
                        players = players,
                        deposits = deposits,
                        withdrawals = withdrawals,
                        ledger = ledger,
                        onRequestFundClick = { showQuickFundRequestModal = true },
                        onNavigateToSection = { section ->
                            when (section) {
                                "fund_request", "fund_allocate", "fund_retrieve" -> currentDestination = AdminNavDestination.FUND_MANAGEMENT
                                "withdrawals" -> currentDestination = AdminNavDestination.WITHDRAWALS
                                "agents" -> currentDestination = AdminNavDestination.AGENTS
                                "deposits" -> currentDestination = AdminNavDestination.DEPOSITS
                                "affiliates" -> currentDestination = AdminNavDestination.AFFILIATES
                                "players" -> currentDestination = AdminNavDestination.PLAYERS
                                else -> currentDestination = AdminNavDestination.DASHBOARD
                            }
                        }
                    )
                    AdminNavDestination.FUND_MANAGEMENT -> FundManagementScreen(
                        adminProfile = adminProfile,
                        agents = agents,
                        ledger = ledger,
                        onRequestFund = { amount, reason ->
                            val result = repository.requestFundFromMasterAdmin(amount, reason)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onAllocateFund = { agentId, amount, note ->
                            val result = repository.allocateFundToAgent(agentId, amount, note)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onRetrieveFund = { agentId, amount, note ->
                            val result = repository.retrieveUnusedAgentFund(agentId, amount, note)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        }
                    )
                    AdminNavDestination.AGENTS -> AgentManagementScreen(
                        agents = agents,
                        onCreateAgent = { name, email, phone, bkash, nagad ->
                            val result = repository.createAgent(name, email, phone, bkash, nagad)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onUpdateStatus = { agentId, status ->
                            val result = repository.updateAgentStatus(agentId, status)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onAllocateFundClick = {
                            currentDestination = AdminNavDestination.FUND_MANAGEMENT
                        }
                    )
                    AdminNavDestination.WITHDRAWALS -> WithdrawalManagementScreen(
                        withdrawals = withdrawals,
                        activeAgents = agents.filter { it.status == "active" },
                        onAssignAgent = { withdrawalId, agentId ->
                            val result = repository.assignWithdrawalToAgent(withdrawalId, agentId)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onConfirmAgentPayout = { withdrawalId, trxId ->
                            val result = repository.confirmAgentWithdrawalExecution(withdrawalId, trxId)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        }
                    )
                    AdminNavDestination.DEPOSITS -> DepositManagementScreen(
                        deposits = deposits
                    )
                    AdminNavDestination.AFFILIATES -> AffiliateManagementScreen(
                        affiliates = affiliates,
                        onCreateAffiliate = { name, email, refCode ->
                            val result = repository.createAffiliate(name, email, refCode)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onToggleStatus = { affId ->
                            val result = repository.toggleAffiliateStatus(affId)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        }
                    )
                    AdminNavDestination.PLAYERS -> PlayerManagementScreen(
                        players = players,
                        onTogglePlayerStatus = { pId ->
                            val result = repository.togglePlayerStatus(pId)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        }
                    )
                    AdminNavDestination.CASINO_GAMES -> CasinoGamesScreen(
                        casinoGames = casinoGames
                    )
                    AdminNavDestination.MESSAGES -> NotificationsAndChatScreen(
                        notifications = notifications,
                        chatMessages = chatMessages,
                        onSendNotification = { title, msg, target ->
                            val result = repository.sendNotification(title, msg, target)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        },
                        onSendChatMessage = { msg ->
                            val result = repository.sendAgentChatMessage(msg)
                            Toast.makeText(context, result.getOrNull() ?: result.exceptionOrNull()?.message, Toast.LENGTH_SHORT).show()
                        }
                    )
                    AdminNavDestination.REPORTS -> ReportsScreen(
                        players = players,
                        deposits = deposits,
                        withdrawals = withdrawals,
                        onExportReports = {
                            Toast.makeText(context, "Full Financial Audit CSV generated & downloaded to device storage", Toast.LENGTH_LONG).show()
                        }
                    )
                    AdminNavDestination.SETTINGS -> SettingsScreen(
                        adminProfile = adminProfile,
                        isDarkTheme = isDarkTheme,
                        currentLanguage = currentLanguage,
                        onToggleTheme = onToggleTheme,
                        onToggleLanguage = onToggleLanguage,
                        onChangePassword = { oldPass, newPass ->
                            Toast.makeText(context, "Password updated successfully in Shared Authentication", Toast.LENGTH_SHORT).show()
                        },
                        onLogout = {
                            isLoggedIn = false
                            Toast.makeText(context, "Logged out successfully", Toast.LENGTH_SHORT).show()
                        }
                    )
                }
            }
        }
    }

    // Quick Request Fund Modal
    if (showQuickFundRequestModal) {
        var reqAmount by remember { mutableStateOf("") }
        var reqReason by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { showQuickFundRequestModal = false },
            containerColor = BgCard,
            title = {
                Text(
                    text = "Request Fund from Master Admin",
                    color = GoldPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Admin cannot mint original funds. Funds are verified and disbursed by Master Admin.",
                        color = TextSecondary,
                        fontSize = 12.sp
                    )
                    OutlinedTextField(
                        value = reqAmount,
                        onValueChange = { reqAmount = it },
                        label = { Text("Amount (BDT)") },
                        modifier = Modifier.fillMaxWidth().testTag("quick_req_amount_input"),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = GoldPrimary,
                            unfocusedBorderColor = BgBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        )
                    )
                    OutlinedTextField(
                        value = reqReason,
                        onValueChange = { reqReason = it },
                        label = { Text("Reason / Operational Purpose") },
                        modifier = Modifier.fillMaxWidth().testTag("quick_req_reason_input"),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = GoldPrimary,
                            unfocusedBorderColor = BgBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        )
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val amt = reqAmount.toDoubleOrNull() ?: 0.0
                        if (amt > 0) {
                            val res = repository.requestFundFromMasterAdmin(amt, reqReason)
                            Toast.makeText(context, res.getOrNull() ?: "Submitted", Toast.LENGTH_SHORT).show()
                            showQuickFundRequestModal = false
                        } else {
                            Toast.makeText(context, "Enter valid positive amount", Toast.LENGTH_SHORT).show()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary, contentColor = BgBase),
                    modifier = Modifier.testTag("quick_req_confirm_button")
                ) {
                    Text("Submit to Master", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showQuickFundRequestModal = false }) {
                    Text("Cancel", color = TextMuted)
                }
            }
        )
    }
}
