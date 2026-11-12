package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.Player
import com.example.ui.theme.*

@Composable
fun PlayerManagementScreen(
    players: List<Player>,
    onTogglePlayerStatus: (playerId: String) -> Unit
) {
    var searchQuery by remember { mutableStateOf("") }
    var selectedPlayerForDetails by remember { mutableStateOf<Player?>(null) }

    val filteredPlayers = players.filter { p ->
        p.name.contains(searchQuery, ignoreCase = true) ||
            p.email.contains(searchQuery, ignoreCase = true) ||
            p.gameUid.contains(searchQuery, ignoreCase = true) ||
            p.phone.contains(searchQuery, ignoreCase = true) ||
            p.lastIp.contains(searchQuery, ignoreCase = true) ||
            p.lastDevice.contains(searchQuery, ignoreCase = true) ||
            p.deviceId.contains(searchQuery, ignoreCase = true) ||
            p.gamesEntered.any { g -> g.contains(searchQuery, ignoreCase = true) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "PLAYER DIRECTORY (${players.size})",
                color = GoldPrimary,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
            Text(
                text = "Hierarchy: Under Admin",
                color = SuccessGreen,
                fontSize = 11.sp
            )
        }

        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            placeholder = { Text("Search Name, UID, Phone, IP, Device or Game...") },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextMuted) },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = GoldPrimary,
                unfocusedBorderColor = GoldLineSubtle,
                focusedTextColor = TextMain,
                unfocusedTextColor = TextMain
            ),
            singleLine = true
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (filteredPlayers.isEmpty()) {
                item {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Box(modifier = Modifier.padding(24.dp), contentAlignment = Alignment.Center) {
                            Text("কোনো প্লেয়ার পাওয়া যায়নি", color = TextDim, fontSize = 13.sp)
                        }
                    }
                }
            } else {
                items(filteredPlayers) { player ->
                    val netPl = player.totalWinAmount - player.totalBetAmount
                    val netSign = if (netPl >= 0.0) "+" else "−"
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("player_item_${player.id}"),
                        shape = RoundedCornerShape(14.dp),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.AccountCircle, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(26.dp))
                                    Spacer(modifier = Modifier.width(10.dp))
                                    Column {
                                        Text(player.name, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                        Text("UID: ${player.gameUid} • Phone: ${player.phone}", color = TextMuted, fontSize = 11.sp)
                                    }
                                }

                                Surface(
                                    color = if (player.status == "active") SuccessGreen.copy(alpha = 0.15f) else AccentRed.copy(alpha = 0.15f),
                                    shape = RoundedCornerShape(50)
                                ) {
                                    Text(
                                        text = player.status.uppercase(),
                                        color = if (player.status == "active") SuccessGreen else AccentRed,
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(10.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column {
                                    Text("Wallet Balance", color = TextMuted, fontSize = 11.sp)
                                    Text("৳ ${String.format("%,.2f", player.walletBalance)}", color = GoldPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                }
                                Column {
                                    Text("Total Deposited", color = TextMuted, fontSize = 11.sp)
                                    Text("৳ ${String.format("%,.0f", player.totalDeposited)}", color = SuccessGreen, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text("Total Withdrawn", color = TextMuted, fontSize = 11.sp)
                                    Text("৳ ${String.format("%,.0f", player.totalWithdrawn)}", color = AccentRed, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column {
                                    Text("Bet Count", color = TextMuted, fontSize = 10.sp)
                                    Text("${player.betCount} bets", color = TextMain, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                }
                                Column {
                                    Text("−Bet / +Win", color = TextMuted, fontSize = 10.sp)
                                    Text(
                                        "−৳${String.format("%,.0f", player.totalBetAmount)} / +৳${String.format("%,.0f", player.totalWinAmount)}",
                                        color = InfoBlue,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 11.sp
                                    )
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text("Net P&L (+/−)", color = TextMuted, fontSize = 10.sp)
                                    Text(
                                        "${netSign}৳${String.format("%,.0f", kotlin.math.abs(netPl))}",
                                        color = if (netPl >= 0.0) SuccessGreen else AccentRed,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 12.sp
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(6.dp))

                            Text(
                                text = "Games: ${if (player.gamesEntered.isEmpty()) "None" else player.gamesEntered.joinToString(", ")}",
                                color = GoldPrimary.copy(alpha = 0.9f),
                                fontSize = 10.sp
                            )
                            Text(
                                text = "IP: ${player.lastIp.ifBlank { "N/A" }} • Device: ${player.lastDevice.ifBlank { "Unknown" }}",
                                color = TextMuted,
                                fontSize = 10.sp
                            )
                            Text(
                                text = "Assigned Agent: ${player.assignedAgentId.ifBlank { "Direct" }} • Affiliate: ${player.affiliateId ?: "None"}",
                                color = TextDim,
                                fontSize = 10.sp
                            )

                            Spacer(modifier = Modifier.height(12.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                OutlinedButton(
                                    onClick = { selectedPlayerForDetails = player },
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Text("View Profile", fontSize = 11.sp)
                                }

                                Button(
                                    onClick = { onTogglePlayerStatus(player.id) },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (player.status == "active") AccentRed else SuccessGreen
                                    ),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Icon(
                                        imageVector = if (player.status == "active") Icons.Default.Block else Icons.Default.CheckCircle,
                                        contentDescription = null,
                                        tint = OnGold,
                                        modifier = Modifier.size(14.dp)
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(
                                        text = if (player.status == "active") "Suspend" else "Activate",
                                        color = OnGold,
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    selectedPlayerForDetails?.let { player ->
        val netPl = player.totalWinAmount - player.totalBetAmount
        val netSign = if (netPl >= 0.0) "+" else "−"
        AlertDialog(
            onDismissRequest = { selectedPlayerForDetails = null },
            title = { Text(player.name, color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text("Game UID: ${player.gameUid}", color = TextMain)
                    Text("Email: ${player.email}", color = TextMain)
                    Text("Phone: ${player.phone}", color = TextMain)
                    Text("Wallet Balance: ৳ ${String.format("%,.2f", player.walletBalance)}", color = GoldPrimary, fontWeight = FontWeight.Bold)
                    Text("Bonus Balance: ৳ ${String.format("%,.2f", player.bonusBalance)}", color = InfoBlue)
                    Text("Total Deposits: ৳ ${String.format("%,.0f", player.totalDeposited)}", color = SuccessGreen)
                    Text("Total Withdrawals: ৳ ${String.format("%,.0f", player.totalWithdrawn)}", color = AccentRed)
                    HorizontalDivider(color = GoldLineSubtle)
                    Text("Bet Count: ${player.betCount} বার বেট", color = TextMain, fontWeight = FontWeight.SemiBold)
                    Text("Total Bet (−): −৳ ${String.format("%,.0f", player.totalBetAmount)}", color = AccentRed)
                    Text("Total Win (+): +৳ ${String.format("%,.0f", player.totalWinAmount)}", color = SuccessGreen)
                    Text(
                        "Net P&L (+/−): ${netSign}৳ ${String.format("%,.0f", kotlin.math.abs(netPl))}",
                        color = if (netPl >= 0.0) SuccessGreen else AccentRed,
                        fontWeight = FontWeight.Bold
                    )
                    Text("Games Entered: ${if (player.gamesEntered.isEmpty()) "None" else player.gamesEntered.joinToString(", ")}", color = GoldPrimary)
                    HorizontalDivider(color = GoldLineSubtle)
                    Text("Last IP: ${player.lastIp.ifBlank { "N/A" }}", color = TextMain)
                    Text("Device: ${player.lastDevice.ifBlank { "Unknown" }}", color = TextMain)
                    Text("Device ID: ${player.deviceId.ifBlank { "N/A" }}", color = TextMuted)
                    Text("Assigned Agent: ${player.assignedAgentId.ifBlank { "None" }}", color = TextMuted)
                    Text("Status: ${player.status.uppercase()}", color = if (player.status == "active") SuccessGreen else AccentRed)
                }
            },
            confirmButton = {
                Button(onClick = { selectedPlayerForDetails = null }, colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)) {
                    Text("Close", color = OnGold)
                }
            },
            containerColor = BgSurface
        )
    }
}
